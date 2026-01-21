/**
 * Bridge HTTP Server
 *
 * Provides HTTP API for Swift app to control the proxy.
 * Uses token-based authentication for security.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AuthManager } from "./auth.js";
import { CertificateManager } from "./certificate-manager.js";
import { ConfigManager } from "./config-manager.js";
import { CONNECTHandler, type TrafficEntry } from "./connect-handler.js";
import { CycleTLSManager } from "./cycletls-manager.js";
import { detectFromHeaders } from "./detection.js";
import { HTTPSProxyServer } from "./https-proxy-server.js";
import { RoutingMiddleware } from "./routing-middleware.js";
import type {
  ApiResponse,
  BridgeConfig,
  BridgeStartOptions,
  HealthResponse,
  LogFilter,
  LogResponse,
  ProxyStatus,
  RawTrafficEntry,
} from "./types.js";

/**
 * Bridge server startup result
 */
export interface BridgeStartResult {
  port: number;
  token: string;
}

/**
 * Bridge HTTP Server
 */
export class BridgeServer {
  private app: Hono;
  private configManager: ConfigManager;
  private routingMiddleware: RoutingMiddleware | null = null;
  private authManager: AuthManager;
  private server: ReturnType<typeof serve> | null = null;
  private certManager: CertificateManager;
  private httpsProxyServer: HTTPSProxyServer | null = null;
  private connectHandler: CONNECTHandler | null = null;
  private cycleTLSManager: CycleTLSManager | null = null;
  private startTime: number;
  private proxyPort: number | undefined;
  private httpsProxyPort: number | undefined;
  private rawTrafficBuffer: RawTrafficEntry[] = [];
  private debugMode = false;
  private debugLogDir: string;
  private debugLogPath: string | null = null;
  private debugLogStream: fs.WriteStream | null = null;

  constructor() {
    this.app = new Hono();
    this.configManager = new ConfigManager();
    this.authManager = new AuthManager();
    this.startTime = Date.now();

    // Initialize certificate manager
    const certDir = path.join(os.homedir(), ".claudish-proxy", "certs");
    this.certManager = new CertificateManager(certDir);

    // Initialize debug log directory
    this.debugLogDir = path.join(os.homedir(), ".claudish-proxy", "logs");

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Apply authentication middleware FIRST (but health is public)
    this.app.use("*", this.authManager.middleware());

    // Restrict CORS to localhost only
    this.app.use(
      "*",
      cors({
        origin: (origin) => {
          // Allow localhost origins
          if (!origin) return null;
          if (origin.startsWith("http://localhost:")) return origin;
          if (origin.startsWith("http://127.0.0.1:")) return origin;
          return null;
        },
      })
    );

    // ============================================
    // PUBLIC ENDPOINTS
    // ============================================

    /**
     * GET /health - Health check (public, no auth required)
     */
    this.app.get("/health", (c) => {
      const response: HealthResponse = {
        status: "ok",
        version: "1.0.0",
        uptime: (Date.now() - this.startTime) / 1000,
      };
      return c.json(response);
    });

    /**
     * GET /proxy.pac - Proxy Auto-Config file (public, no auth required)
     * Routes traffic to HTTP server (which handles CONNECT)
     *
     * Intercepts traffic for:
     * - api.anthropic.com (Claude Code CLI)
     * - claude.ai (Claude Desktop - uses HTTP POST + SSE for chat, not WebSocket)
     */
    this.app.get("/proxy.pac", (c) => {
      const port = this.proxyPort || 0;
      const pacContent = `function FindProxyForURL(url, host) {
  // Claude Code CLI and Claude Desktop internal API
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com")) {
    return "PROXY 127.0.0.1:${port}";
  }
  // Claude Desktop (chat is HTTP+SSE, WebSocket only for notifications)
  if (host === "claude.ai" || host.endsWith(".claude.ai")) {
    return "PROXY 127.0.0.1:${port}";
  }
  return "DIRECT";
}`;
      c.header("Content-Type", "application/x-ns-proxy-autoconfig");
      return c.text(pacContent);
    });

    /**
     * GET /debug/state - Debug endpoint to show config and routing state (public)
     */
    this.app.get("/debug/state", (c) => {
      const config = this.configManager.getConfig();
      const routingConfig = this.connectHandler?.getRoutingConfig() || { enabled: false, modelMap: {} };
      return c.json({
        config,
        routingConfig,
        proxyEnabled: this.routingMiddleware !== null,
        connectHandlerExists: this.connectHandler !== null,
      });
    });

    // ============================================
    // PROTECTED ENDPOINTS (require Bearer token)
    // ============================================

    /**
     * GET /status - Proxy status
     */
    this.app.get("/status", (c) => {
      const status: ProxyStatus = {
        running: this.routingMiddleware !== null,
        port: this.proxyPort,
        detectedApps: this.routingMiddleware?.getDetectedApps() || [],
        totalRequests: this.routingMiddleware?.getLogs().length || 0,
        activeConnections: 0,
        uptime: (Date.now() - this.startTime) / 1000,
        version: "1.0.0",
      };
      return c.json(status);
    });

    /**
     * GET /config - Get current configuration
     */
    this.app.get("/config", (c) => {
      return c.json(this.configManager.getConfig());
    });

    /**
     * POST /config - Update configuration
     */
    this.app.post("/config", async (c) => {
      try {
        const body = (await c.req.json()) as Partial<BridgeConfig>;
        const result = this.configManager.updateConfig(body);

        // SYNC: Also update connectHandler routing config if model mappings changed
        if (this.connectHandler && body.apps) {
          // Merge all app modelMaps into a single routing config
          const mergedModelMap: Record<string, string> = {};
          for (const appConfig of Object.values(body.apps)) {
            if (appConfig.modelMap) {
              Object.assign(mergedModelMap, appConfig.modelMap);
            }
          }

          // Check if any models are being routed (not "internal")
          const hasRouting = Object.values(mergedModelMap).some(
            (target) => target && target !== "internal"
          );

          // Filter out "internal" mappings (passthrough)
          const filteredModelMap: Record<string, string> = {};
          for (const [source, target] of Object.entries(mergedModelMap)) {
            if (target && target !== "internal") {
              filteredModelMap[source] = target;
            }
          }

          this.connectHandler.setRoutingConfig({
            enabled: hasRouting,
            modelMap: filteredModelMap,
          });

          console.log(
            `[Server] Synced routing config from /config: enabled=${hasRouting}, models=${Object.keys(filteredModelMap).join(", ")}`
          );
        }

        const response: ApiResponse<BridgeConfig> = {
          success: true,
          data: result,
        };
        return c.json(response);
      } catch (error) {
        const response: ApiResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        return c.json(response, 400);
      }
    });

    /**
     * POST /proxy/enable - Enable the proxy
     */
    this.app.post("/proxy/enable", async (c) => {
      if (this.routingMiddleware) {
        return c.json(
          {
            success: false,
            error: "Proxy already running",
          },
          400
        );
      }

      try {
        const body = (await c.req.json()) as BridgeStartOptions;

        // Create routing middleware with API keys
        this.routingMiddleware = new RoutingMiddleware(this.configManager, body.apiKeys);
        console.error(`[DEBUG] routingMiddleware created: ${this.routingMiddleware !== null}`);

        // Create Node.js HTTP request handler that delegates to RoutingMiddleware
        const nodeRequestHandler = (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse
        ) => {
          // Log ALL intercepted traffic
          const userAgent = req.headers["user-agent"] || "";
          const origin = req.headers.origin || "";
          const host = req.headers.host || "";
          const detection = detectFromHeaders({ userAgent, origin, host });

          const trafficEntry: RawTrafficEntry = {
            timestamp: new Date().toISOString(),
            method: req.method || "UNKNOWN",
            host: host,
            path: req.url || "/",
            userAgent: userAgent,
            origin: origin || undefined,
            contentType: req.headers["content-type"] || undefined,
            contentLength: req.headers["content-length"]
              ? Number.parseInt(req.headers["content-length"], 10)
              : undefined,
            detectedApp: detection.name,
            confidence: detection.confidence,
          };

          this.rawTrafficBuffer.push(trafficEntry);
          this.writeDebugLog(trafficEntry);
          // Keep only last 500 entries
          if (this.rawTrafficBuffer.length > 500) {
            this.rawTrafficBuffer.shift();
          }

          console.error(
            `[traffic] ${detection.name} (${(detection.confidence * 100).toFixed(0)}%) ${req.method} ${host}${req.url}`
          );

          // Only route /v1/messages to RoutingMiddleware, forward everything else
          if (req.url !== "/v1/messages" || req.method !== "POST") {
            // Forward to real server
            this.forwardToRealServer(req, res, host);
            return;
          }

          // Collect body
          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString();
          });
          req.on("end", async () => {
            try {
              // Create a Web API Request from Node.js request
              const headers = new Headers();
              for (const [key, value] of Object.entries(req.headers)) {
                if (value) {
                  headers.set(key, Array.isArray(value) ? value.join(", ") : value);
                }
              }
              const webRequest = new Request(`http://localhost${req.url}`, {
                method: req.method,
                headers,
                body,
              });

              // Create Hono app and handle request
              const honoApp = new Hono();
              honoApp.post("/v1/messages", this.routingMiddleware!.handle());
              const webResponse = await honoApp.fetch(webRequest);

              // Write response back to Node.js response
              res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));

              if (webResponse.body) {
                const reader = webResponse.body.getReader();
                const pump = async (): Promise<void> => {
                  const { done, value } = await reader.read();
                  if (done) {
                    res.end();
                    return;
                  }
                  res.write(value);
                  return pump();
                };
                await pump();
              } else {
                res.end(await webResponse.text());
              }
            } catch (err) {
              console.error("[proxy] Error handling request:", err);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal proxy error" }));
            }
          });
        };

        // Create HTTPS proxy server with the Node.js request handler
        this.httpsProxyServer = new HTTPSProxyServer(this.certManager, nodeRequestHandler);

        // Start HTTPS proxy server
        await this.httpsProxyServer.start();
        this.httpsProxyPort = this.httpsProxyServer.getPort();

        // Create traffic callback to log CONNECT traffic to the buffer
        const trafficCallback = (entry: TrafficEntry) => {
          // Include model info in the log if available
          const modelSuffix = entry.model ? ` [${entry.model}]` : "";
          const rawEntry: RawTrafficEntry = {
            timestamp: entry.timestamp,
            method:
              entry.method ||
              (entry.direction === "response" ? `← ${entry.statusCode}` : "CONNECT"),
            host: entry.host,
            path: entry.path || "/",
            userAgent: "Claude Desktop (via CONNECT)",
            contentType: entry.contentType,
            contentLength: entry.contentLength,
            detectedApp: "Claude Desktop",
            confidence: 1.0,
          };
          this.rawTrafficBuffer.push(rawEntry);
          this.writeDebugLog(rawEntry, modelSuffix);
          if (this.rawTrafficBuffer.length > 500) {
            this.rawTrafficBuffer.shift();
          }
          console.error(
            `[traffic] Claude Desktop (100%) ${rawEntry.method} ${entry.host}${entry.path || ""}${modelSuffix}`
          );
        };

        // Initialize CycleTLS manager for Chrome-fingerprinted requests (optional)
        // If CycleTLS fails, we'll fall back to native TLS which may get 403 from Cloudflare
        this.cycleTLSManager = new CycleTLSManager();
        try {
          await this.cycleTLSManager.initialize();
          console.error("[bridge] CycleTLS initialized successfully");
        } catch (cycleTLSError) {
          console.error("[bridge] CycleTLS failed to initialize, will use native TLS fallback:", cycleTLSError);
          this.cycleTLSManager = null;
        }

        // Create CONNECT handler with the same request handler, traffic callback, and CycleTLS manager
        this.connectHandler = new CONNECTHandler(
          this.certManager,
          nodeRequestHandler,
          trafficCallback,
          this.cycleTLSManager || undefined
        );

        // Set API keys for alternative providers
        this.connectHandler.setApiKeys(body.apiKeys);

        // SYNC: Apply existing routing config from configManager to new connectHandler
        const currentConfig = this.configManager.getConfig();
        if (currentConfig.apps) {
          const mergedModelMap: Record<string, string> = {};
          for (const appConfig of Object.values(currentConfig.apps)) {
            if (appConfig.modelMap) {
              Object.assign(mergedModelMap, appConfig.modelMap);
            }
          }

          const hasRouting = Object.values(mergedModelMap).some(
            (target) => target && target !== "internal"
          );

          const filteredModelMap: Record<string, string> = {};
          for (const [source, target] of Object.entries(mergedModelMap)) {
            if (target && target !== "internal") {
              filteredModelMap[source] = target;
            }
          }

          this.connectHandler.setRoutingConfig({
            enabled: hasRouting,
            modelMap: filteredModelMap,
          });

          console.log(
            `[Server] Applied routing config on proxy enable: enabled=${hasRouting}, models=${Object.keys(filteredModelMap).join(", ")}`
          );
        }

        // Attach CONNECT handler to HTTP server
        if (this.server) {
          this.server.on("connect", (req, socket, head) => {
            this.connectHandler?.handle(req, socket, head);
          });
        }

        // Attach CONNECT handler to HTTPS proxy server for tunneling
        if (this.httpsProxyServer) {
          this.httpsProxyServer.setConnectHandler((req, socket, head) => {
            this.connectHandler?.handle(req, socket, head);
          });
        }

        const response: ApiResponse<{
          proxyUrl: string;
          httpsProxyUrl: string;
          actualPort: number;
          httpsProxyPort: number;
        }> = {
          success: true,
          data: {
            proxyUrl: `http://127.0.0.1:${this.proxyPort}`,
            httpsProxyUrl: `https://127.0.0.1:${this.httpsProxyPort}`,
            actualPort: this.proxyPort || 0,
            httpsProxyPort: this.httpsProxyPort,
          },
        };
        return c.json(response);
      } catch (error) {
        const response: ApiResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        return c.json(response, 500);
      }
    });

    /**
     * POST /proxy/disable - Disable the proxy
     */
    this.app.post("/proxy/disable", async (c) => {
      if (!this.routingMiddleware) {
        return c.json(
          {
            success: false,
            error: "Proxy not running",
          },
          400
        );
      }

      try {
        // Stop HTTPS proxy server
        if (this.httpsProxyServer) {
          await this.httpsProxyServer.stop();
          this.httpsProxyServer = null;
        }

        // Shutdown CycleTLS manager
        if (this.cycleTLSManager) {
          await this.cycleTLSManager.shutdown();
          this.cycleTLSManager = null;
        }

        // Remove CONNECT handler
        if (this.server && this.connectHandler) {
          this.server.removeAllListeners("connect");
          this.connectHandler = null;
        }

        // Stop routing middleware
        console.error(`[DEBUG] Disabling proxy - setting routingMiddleware to null`);
        await this.routingMiddleware.shutdown();
        this.routingMiddleware = null;

        // Clear ports
        this.httpsProxyPort = undefined;

        return c.json({
          success: true,
          message: "Proxy stopped",
        });
      } catch (error) {
        return c.json(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    });

    /**
     * GET /logs - Get request logs
     */
    this.app.get("/logs", (c) => {
      const query: LogFilter = {
        limit: Number(c.req.query("limit")) || 100,
        offset: Number(c.req.query("offset")) || 0,
        filter: c.req.query("filter") || undefined,
        since: c.req.query("since") || undefined,
      };

      if (!this.routingMiddleware) {
        const response: LogResponse = {
          logs: [],
          total: 0,
          hasMore: false,
        };
        return c.json(response);
      }

      let logs = this.routingMiddleware.getLogs();

      // Apply filter
      if (query.filter) {
        const filterLower = query.filter.toLowerCase();
        logs = logs.filter(
          (log) =>
            log.app.toLowerCase().includes(filterLower) ||
            log.requestedModel.toLowerCase().includes(filterLower) ||
            log.targetModel.toLowerCase().includes(filterLower)
        );
      }

      // Apply since filter
      if (query.since) {
        const sinceDate = new Date(query.since);
        logs = logs.filter((log) => new Date(log.timestamp) >= sinceDate);
      }

      const total = logs.length;
      const offset = query.offset || 0;
      const limit = query.limit || 100;

      const response: LogResponse = {
        logs: logs.slice(offset, offset + limit),
        total,
        hasMore: total > offset + limit,
        nextOffset: total > offset + limit ? offset + limit : undefined,
      };

      return c.json(response);
    });

    /**
     * DELETE /logs - Clear logs
     */
    this.app.delete("/logs", (c) => {
      if (this.routingMiddleware) {
        this.routingMiddleware.clearLogs();
      }
      return c.json({ success: true, message: "Logs cleared" });
    });

    /**
     * GET /traffic - Get raw traffic log (all intercepted requests)
     */
    this.app.get("/traffic", (c) => {
      const limit = Number(c.req.query("limit")) || 100;
      const traffic = this.rawTrafficBuffer.slice(-limit);
      return c.json({
        traffic,
        total: this.rawTrafficBuffer.length,
      });
    });

    /**
     * DELETE /traffic - Clear raw traffic log
     */
    this.app.delete("/traffic", (c) => {
      this.rawTrafficBuffer = [];
      return c.json({ success: true, message: "Traffic log cleared" });
    });

    /**
     * GET /models - Get model tracking info for Claude Desktop
     * Returns current selected model and conversation -> model mappings
     */
    this.app.get("/models", (c) => {
      if (!this.connectHandler) {
        return c.json({
          currentModel: null,
          conversationModels: {},
          lastUpdated: null,
          hasAuth: false,
        });
      }

      const tracker = this.connectHandler.getModelTracker();
      const auth = this.connectHandler.getCapturedAuth();
      return c.json({
        currentModel: tracker.currentModel,
        conversationModels: this.connectHandler.getConversationModels(),
        lastUpdated: tracker.lastUpdated,
        hasAuth: this.connectHandler.hasAuth(),
        organizationId: auth.organizationId,
      });
    });

    /**
     * POST /models/refresh - Fetch conversations from Claude API using captured auth
     * This allows refreshing the model mappings without waiting for traffic
     */
    this.app.post("/models/refresh", async (c) => {
      if (!this.connectHandler) {
        return c.json({ success: false, error: "Proxy not running" }, 400);
      }

      if (!this.connectHandler.hasAuth()) {
        return c.json(
          {
            success: false,
            error: "No auth captured yet. Open Claude Desktop first to capture authentication.",
          },
          400
        );
      }

      try {
        const conversations = await this.connectHandler.fetchConversations();
        return c.json({
          success: true,
          data: {
            count: conversations.length,
            conversationModels: this.connectHandler.getConversationModels(),
          },
        });
      } catch (error) {
        return c.json(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    });

    /**
     * POST /routing - Set routing configuration for model replacement
     *
     * Example body:
     * {
     *   "enabled": true,
     *   "modelMap": {
     *     "claude-opus-4-5-20251101": "openai/gpt-4o",
     *     "claude-sonnet-4-5-20250929": "anthropic/claude-3-sonnet"
     *   }
     * }
     */
    this.app.post("/routing", async (c) => {
      if (!this.connectHandler) {
        return c.json({ success: false, error: "Proxy not running" }, 400);
      }

      try {
        const body = (await c.req.json()) as {
          enabled?: boolean;
          modelMap?: Record<string, string>;
        };

        this.connectHandler.setRoutingConfig({
          enabled: body.enabled ?? false,
          modelMap: body.modelMap ?? {},
        });

        return c.json({
          success: true,
          data: this.connectHandler.getRoutingConfig(),
        });
      } catch (error) {
        return c.json(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    });

    /**
     * GET /routing - Get current routing configuration
     */
    this.app.get("/routing", (c) => {
      if (!this.connectHandler) {
        return c.json({ success: false, error: "Proxy not running" }, 400);
      }

      return c.json({
        success: true,
        data: this.connectHandler.getRoutingConfig(),
      });
    });

    /**
     * POST /debug - Enable/disable debug mode (traffic logging to file)
     */
    this.app.post("/debug", async (c) => {
      try {
        const body = (await c.req.json()) as { enabled?: boolean };
        const enabled = body.enabled ?? false;

        if (enabled && !this.debugMode) {
          // Enable debug mode - create new session log file
          // Ensure log directory exists
          if (!fs.existsSync(this.debugLogDir)) {
            fs.mkdirSync(this.debugLogDir, { recursive: true });
          }

          // Create timestamped log file for this session
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          this.debugLogPath = path.join(this.debugLogDir, `debug-${timestamp}.log`);

          this.debugLogStream = fs.createWriteStream(this.debugLogPath, { flags: "w" });
          this.debugLogStream.write(
            `=== Debug session started at ${new Date().toISOString()} ===\n\n`
          );
          console.error(`[debug] Debug mode enabled, logging to: ${this.debugLogPath}`);
        } else if (!enabled && this.debugMode) {
          // Disable debug mode - close log file stream
          if (this.debugLogStream) {
            this.debugLogStream.write(
              `\n=== Debug session ended at ${new Date().toISOString()} ===\n`
            );
            this.debugLogStream.end();
            this.debugLogStream = null;
          }
          console.error("[debug] Debug mode disabled");
        }

        this.debugMode = enabled;

        const response: ApiResponse<{ enabled: boolean; logPath: string | null }> = {
          success: true,
          data: {
            enabled: this.debugMode,
            logPath: this.debugLogPath,
          },
        };
        return c.json(response);
      } catch (error) {
        const response: ApiResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        return c.json(response, 500);
      }
    });

    /**
     * GET /debug - Get current debug mode status
     */
    this.app.get("/debug", (c) => {
      const response: ApiResponse<{ enabled: boolean; logPath: string | null; logDir: string }> = {
        success: true,
        data: {
          enabled: this.debugMode,
          logPath: this.debugLogPath,
          logDir: this.debugLogDir,
        },
      };
      return c.json(response);
    });

    /**
     * GET /certificates/ca - Get CA certificate for installation
     */
    this.app.get("/certificates/ca", async (c) => {
      try {
        const cert = this.certManager.getCACertPEM();
        const metadata = this.certManager.getCAMetadata();

        const response: ApiResponse<{
          cert: string;
          fingerprint: string;
          validFrom: string;
          validTo: string;
        }> = {
          success: true,
          data: {
            cert,
            fingerprint: metadata.fingerprint,
            validFrom: metadata.validFrom.toISOString(),
            validTo: metadata.validTo.toISOString(),
          },
        };
        return c.json(response);
      } catch (error) {
        const response: ApiResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        return c.json(response, 500);
      }
    });

    /**
     * GET /certificates/status - Get certificate installation status
     */
    this.app.get("/certificates/status", async (c) => {
      try {
        const metadata = this.certManager.getCAMetadata();
        const leafCertCount = this.certManager.getLeafCertCount();
        const certDir = this.certManager.getCertDir();

        const response: ApiResponse<{
          initialized: boolean;
          caFingerprint: string;
          leafCertCount: number;
          certDir: string;
        }> = {
          success: true,
          data: {
            initialized: true,
            caFingerprint: metadata.fingerprint,
            leafCertCount,
            certDir,
          },
        };
        return c.json(response);
      } catch (error) {
        const response: ApiResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        return c.json(response, 500);
      }
    });

    // ============================================
    // PROXY PASS-THROUGH (when enabled)
    // ============================================

    /**
     * POST /v1/messages - Anthropic Messages API proxy
     */
    this.app.post("/v1/messages", async (c) => {
      if (!this.routingMiddleware) {
        return c.json(
          {
            error: "Proxy not enabled",
            message: "Call POST /proxy/enable first",
          },
          503
        );
      }

      // Delegate to routing middleware
      const handler = this.routingMiddleware.handle();
      // The next function must return Promise<void> for Hono middleware
      return handler(c, async () => {
        // This shouldn't be called since routing middleware handles everything
        // Return void to satisfy Next type
      });
    });
  }

  /**
   * Write a traffic entry to the debug log file (if debug mode is enabled)
   */
  private writeDebugLog(entry: RawTrafficEntry, extra?: string): void {
    if (!this.debugMode || !this.debugLogStream) return;

    const line = `[${entry.timestamp}] ${entry.detectedApp} (${Math.round(entry.confidence * 100)}%) ${entry.method} ${entry.host}${entry.path}${extra ? ` ${extra}` : ""}\n`;
    this.debugLogStream.write(line);
  }

  /**
   * Forward a request to the real server (pass-through proxy)
   */
  private forwardToRealServer(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    targetHost: string
  ): void {
    const https = require("node:https");

    // Collect request body
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);

      // Forward to real server
      const options = {
        hostname: targetHost,
        port: 443,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: targetHost, // Ensure correct host header
        },
      };

      const proxyReq = https.request(options, (proxyRes: import("node:http").IncomingMessage) => {
        // Forward response headers
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

        // Forward response body
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (err: Error) => {
        console.error(`[forward] Error forwarding to ${targetHost}:`, err.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Gateway", details: err.message }));
      });

      // Send request body
      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  }

  /**
   * Start the bridge server
   *
   * @param port - Port to listen on (0 = random available port)
   * @returns Startup result with actual port and auth token
   */
  async start(port = 0): Promise<BridgeStartResult> {
    // Initialize certificates
    await this.certManager.initialize();

    // Pre-generate certificates for known domains
    // - api.anthropic.com: Claude Code CLI
    // - a-api.anthropic.com: Claude Desktop app
    await Promise.all([
      this.certManager.getCertForDomain("api.anthropic.com"),
      this.certManager.getCertForDomain("a-api.anthropic.com"),
    ]);

    return new Promise((resolve) => {
      this.server = serve({
        fetch: this.app.fetch,
        port,
        hostname: "127.0.0.1", // IMPORTANT: Only bind to localhost
      });

      this.server.on("listening", () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === "object" && addr?.port ? addr.port : port;
        this.proxyPort = actualPort;

        const token = this.authManager.getToken();

        // Write token to file for external access
        const fs = require("node:fs");
        const tokenFile = require("node:path").join(
          require("node:os").homedir(),
          ".claudish-proxy",
          "bridge-token"
        );
        try {
          fs.writeFileSync(
            tokenFile,
            JSON.stringify({
              port: actualPort,
              token,
              pid: process.pid,
              startTime: new Date().toISOString(),
            })
          );
        } catch (e) {
          console.error("[bridge] Failed to write token file:", e);
        }

        // Output structured data to stdout for Swift app to parse
        // IMPORTANT: These lines must be parseable by the Swift app
        console.log(`CLAUDISH_BRIDGE_PORT=${actualPort}`);
        console.log(`CLAUDISH_BRIDGE_TOKEN=${token}`);

        // Log to stderr (not parsed by Swift app)
        console.error(`[bridge] Server started on http://127.0.0.1:${actualPort}`);
        console.error(`[bridge] Token: ${this.authManager.getMaskedToken()}`);

        resolve({
          port: actualPort,
          token,
        });
      });
    });
  }

  /**
   * Stop the bridge server
   */
  async stop(): Promise<void> {
    // Close debug log stream
    if (this.debugLogStream) {
      this.debugLogStream.write(`\n=== Server stopped at ${new Date().toISOString()} ===\n`);
      this.debugLogStream.end();
      this.debugLogStream = null;
      this.debugMode = false;
    }

    // Stop HTTPS proxy server
    if (this.httpsProxyServer) {
      await this.httpsProxyServer.stop();
      this.httpsProxyServer = null;
    }

    // Shutdown CycleTLS manager
    if (this.cycleTLSManager) {
      await this.cycleTLSManager.shutdown();
      this.cycleTLSManager = null;
    }

    // Remove CONNECT handler
    if (this.server && this.connectHandler) {
      this.server.removeAllListeners("connect");
      this.connectHandler = null;
    }

    // Stop routing middleware
    if (this.routingMiddleware) {
      console.error(`[DEBUG] stop() called - setting routingMiddleware to null`);
      await this.routingMiddleware.shutdown();
      this.routingMiddleware = null;
    }

    // Stop HTTP server
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err: Error | undefined) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  /**
   * Get the current auth token
   */
  getToken(): string {
    return this.authManager.getToken();
  }
}
