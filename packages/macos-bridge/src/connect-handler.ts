import * as fs from "node:fs";
import type * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import type { CertificateManager } from "./certificate-manager";
import { HTTPRequestParser, type ParsedHTTPRequest } from "./http-parser";
import type { ApiKeys } from "./types";

/**
 * Traffic entry for logging intercepted requests
 */
export interface TrafficEntry {
  timestamp: string;
  direction: "request" | "response";
  method?: string;
  host: string;
  path?: string;
  statusCode?: number;
  contentLength?: number;
  contentType?: string;
  model?: string;
  conversationId?: string;
}

/**
 * Callback for logging traffic to external buffer
 */
export type TrafficCallback = (entry: TrafficEntry) => void;

/**
 * Model tracking for Claude Desktop conversations
 */
export interface ModelTracker {
  /** Most recently selected model from model_configs request */
  currentModel: string | null;
  /** Map of conversation UUID -> model ID */
  conversationModels: Map<string, string>;
  /** Last update timestamp */
  lastUpdated: string | null;
}

/**
 * Captured auth for making API requests
 */
export interface CapturedAuth {
  /** Organization ID from URL */
  organizationId: string | null;
  /** All headers needed for auth */
  headers: Record<string, string>;
  /** When auth was captured */
  capturedAt: string | null;
}

/**
 * Routing configuration for model replacement
 */
export interface RoutingConfig {
  /** Whether routing is enabled */
  enabled: boolean;
  /** Model mappings: source model -> target model (e.g., "claude-opus" -> "openai/gpt-4o") */
  modelMap: Record<string, string>;
}

/**
 * Handles HTTP CONNECT requests for forward proxy mode
 *
 * Flow:
 * 1. Client sends: CONNECT api.anthropic.com:443 HTTP/1.1
 * 2. Parse target hostname and port from req.url
 * 3. Respond with: HTTP/1.1 200 Connection Established
 * 4. Create TLS server using tls.createServer with SNI callback
 * 5. Emit 'connection' event on TLS server with client socket
 * 6. After TLS handshake, handle decrypted HTTP requests
 */
export class CONNECTHandler {
  private certManager: CertificateManager;
  private trafficCallback?: TrafficCallback;

  /** Track model selections for Claude Desktop */
  private modelTracker: ModelTracker = {
    currentModel: null,
    conversationModels: new Map(),
    lastUpdated: null,
  };

  /** Captured auth for making our own API requests */
  private capturedAuth: CapturedAuth = {
    organizationId: null,
    headers: {},
    capturedAt: null,
  };

  /** Routing configuration for model replacement */
  private routingConfig: RoutingConfig = {
    enabled: false,
    modelMap: {},
  };

  /** API keys for alternative providers */
  private apiKeys: ApiKeys = {};

  constructor(
    certManager: CertificateManager,
    _requestHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    trafficCallback?: TrafficCallback
  ) {
    this.certManager = certManager;
    // Note: requestHandler reserved for future HTTP routing support
    this.trafficCallback = trafficCallback;
  }

  /**
   * Set API keys for alternative providers
   */
  setApiKeys(apiKeys: ApiKeys): void {
    this.apiKeys = apiKeys;
  }

  /**
   * Get the current model tracker state
   */
  getModelTracker(): ModelTracker {
    return this.modelTracker;
  }

  /**
   * Get the model for a specific conversation
   */
  getConversationModel(conversationId: string): string | null {
    return this.modelTracker.conversationModels.get(conversationId) || null;
  }

  /**
   * Get all conversation -> model mappings as an object
   */
  getConversationModels(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [convId, model] of this.modelTracker.conversationModels) {
      result[convId] = model;
    }
    return result;
  }

  /**
   * Get captured auth info
   */
  getCapturedAuth(): CapturedAuth {
    return this.capturedAuth;
  }

  /**
   * Check if we have valid captured auth
   */
  hasAuth(): boolean {
    return (
      this.capturedAuth.organizationId !== null && Object.keys(this.capturedAuth.headers).length > 0
    );
  }

  /**
   * Set routing configuration
   */
  setRoutingConfig(config: RoutingConfig): void {
    this.routingConfig = config;
    console.log(
      `[CONNECTHandler] Routing ${config.enabled ? "enabled" : "disabled"}, ${Object.keys(config.modelMap).length} mappings`
    );
  }

  /**
   * Get routing configuration
   */
  getRoutingConfig(): RoutingConfig {
    return this.routingConfig;
  }

  /**
   * Check if a model should be routed to an alternative provider
   * Returns the target model if routing is configured, null otherwise
   */
  getRoutingTarget(model: string): string | null {
    if (!this.routingConfig.enabled) {
      return null;
    }
    return this.routingConfig.modelMap[model] || null;
  }

  /**
   * Check if a conversation should be routed based on its model
   */
  shouldRouteConversation(conversationId: string): {
    shouldRoute: boolean;
    sourceModel: string | null;
    targetModel: string | null;
  } {
    const sourceModel = this.modelTracker.conversationModels.get(conversationId) || null;
    if (!sourceModel) {
      return { shouldRoute: false, sourceModel: null, targetModel: null };
    }
    const targetModel = this.getRoutingTarget(sourceModel);
    return {
      shouldRoute: targetModel !== null,
      sourceModel,
      targetModel,
    };
  }

  /**
   * Fetch conversations using captured auth
   */
  async fetchConversations(): Promise<Array<{ uuid: string; model: string | null; name: string }>> {
    if (!this.hasAuth()) {
      throw new Error("No auth captured yet. Open Claude Desktop first.");
    }

    const https = require("node:https");
    const url = `/api/organizations/${this.capturedAuth.organizationId}/chat_conversations?limit=100&starred=false&consistency=eventual`;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: "claude.ai",
        port: 443,
        path: url,
        method: "GET",
        headers: {
          ...this.capturedAuth.headers,
          Host: "claude.ai",
          Accept: "application/json",
        },
      };

      const req = https.request(options, (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const conversations = JSON.parse(body) as Array<{
              uuid: string;
              model: string | null;
              name: string;
            }>;

            // Update model tracker
            for (const conv of conversations) {
              if (conv.uuid && conv.model) {
                this.modelTracker.conversationModels.set(conv.uuid, conv.model);
              }
            }
            this.modelTracker.lastUpdated = new Date().toISOString();

            resolve(conversations);
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Handle HTTP CONNECT request and upgrade to TLS
   *
   * @param req Incoming HTTP CONNECT request
   * @param clientSocket Raw TCP socket from client
   * @param head First packet of the upgraded stream (usually TLS ClientHello)
   */
  handle(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    // Parse target from CONNECT request
    const { hostname, port } = this.parseConnectRequest(req);

    if (!hostname || !port) {
      this.respondError(clientSocket, "CONNECT_PARSE_ERROR: Invalid CONNECT request format");
      return;
    }

    console.log(`[CONNECTHandler] CONNECT request for ${hostname}:${port}`);

    // Respond with 200 Connection Established
    clientSocket.write(
      "HTTP/1.1 200 Connection Established\r\n" + "Proxy-agent: Claudish-Proxy\r\n" + "\r\n"
    );

    // Upgrade to TLS
    this.upgradeTLS(hostname, clientSocket, head);
  }

  /**
   * Parse hostname and port from CONNECT request URL
   *
   * Example: CONNECT api.anthropic.com:443 HTTP/1.1
   * Returns: { hostname: 'api.anthropic.com', port: 443 }
   */
  private parseConnectRequest(req: http.IncomingMessage): {
    hostname: string | null;
    port: number | null;
  } {
    if (!req.url) {
      return { hostname: null, port: null };
    }

    const match = req.url.match(/^([^:]+):(\d+)$/);
    if (!match) {
      return { hostname: null, port: null };
    }

    const hostname = match[1];
    const port = Number.parseInt(match[2], 10);

    return { hostname, port };
  }

  /**
   * Upgrade client socket to TLS using dynamic certificate
   *
   * @param hostname Target hostname (e.g., 'api.anthropic.com')
   * @param clientSocket Client's raw TCP socket
   * @param head Initial data (TLS ClientHello)
   */
  private async upgradeTLS(
    hostname: string,
    clientSocket: net.Socket,
    head: Buffer
  ): Promise<void> {
    console.log(`[CONNECTHandler] Starting TLS upgrade for ${hostname}`);

    try {
      // Get certificate for this hostname
      const { cert, key } = await this.certManager.getCertForDomain(hostname);

      // Create a local TLS server on a random port
      const tlsServer = tls.createServer({
        cert: cert,
        key: key,
        requestCert: false,
      });

      tlsServer.on("secureConnection", (tlsSocket: tls.TLSSocket) => {
        console.log(`[CONNECTHandler] TLS handshake completed for ${hostname}`);
        this.handleDecryptedHTTP(tlsSocket, hostname);
      });

      tlsServer.on("tlsClientError", (err) => {
        console.error(`[CONNECTHandler] TLS_CLIENT_ERROR for ${hostname}:`, err.message);
      });

      // Start listening on random port
      tlsServer.listen(0, "127.0.0.1", () => {
        const addr = tlsServer.address() as net.AddressInfo;
        console.log(`[CONNECTHandler] TLS server for ${hostname} listening on port ${addr.port}`);

        // Connect client socket to our TLS server via a local connection
        const localConn = net.connect(addr.port, "127.0.0.1", () => {
          console.log(`[CONNECTHandler] Local connection established for ${hostname}`);

          // Pipe client socket to local connection and back
          clientSocket.pipe(localConn);
          localConn.pipe(clientSocket);

          // Push any initial data
          if (head && head.length > 0) {
            localConn.write(head);
          }
        });

        localConn.on("error", (err) => {
          console.error(`[CONNECTHandler] Local connection error for ${hostname}:`, err.message);
          clientSocket.destroy();
        });

        clientSocket.on("error", (err) => {
          console.error(`[CONNECTHandler] Client socket error for ${hostname}:`, err.message);
          localConn.destroy();
        });

        clientSocket.on("close", () => {
          localConn.destroy();
          tlsServer.close();
        });
      });
    } catch (err) {
      console.error(`[CONNECTHandler] Failed to setup TLS for ${hostname}:`, err);
      clientSocket.destroy();
    }
  }

  /**
   * Capture auth headers from an intercepted request
   */
  private captureAuthFromRequest(data: Buffer | string, path: string): void {
    // Extract organization ID from path
    const orgMatch = path.match(/\/organizations\/([a-f0-9-]+)/);
    if (orgMatch && !this.capturedAuth.organizationId) {
      this.capturedAuth.organizationId = orgMatch[1];
    }

    // Parse headers from request
    const str =
      typeof data === "string" ? data : data.toString("utf8", 0, Math.min(4000, data.length));
    const headerEnd = str.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const headerSection = str.slice(0, headerEnd);
    const lines = headerSection.split("\r\n").slice(1); // Skip request line

    // Headers we want to capture for auth
    const authHeaders = [
      "cookie",
      "authorization",
      "anthropic-anonymous-id",
      "anthropic-client-platform",
      "anthropic-client-sha",
      "anthropic-client-version",
      "anthropic-device-id",
    ];

    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const name = line.slice(0, colonIdx).toLowerCase().trim();
      const value = line.slice(colonIdx + 1).trim();

      if (authHeaders.includes(name) && value) {
        this.capturedAuth.headers[name] = value;
      }
    }

    // Mark as captured if we have cookie or authorization
    if (this.capturedAuth.headers.cookie || this.capturedAuth.headers.authorization) {
      this.capturedAuth.capturedAt = new Date().toISOString();
      if (!this.capturedAuth.organizationId) {
        console.log("[CONNECTHandler] Auth headers captured (waiting for org ID)");
      } else {
        console.log(
          `[CONNECTHandler] Auth captured for org ${this.capturedAuth.organizationId.slice(0, 8)}...`
        );
      }
    }
  }

  /**
   * Extract model ID from model_configs path
   * Example: "/api/organizations/.../model_configs/claude-opus-4-5-20251101" -> "claude-opus-4-5-20251101"
   */
  private extractModelFromPath(path: string): string | null {
    const match = path.match(/\/model_configs\/([^?\s]+)/);
    return match ? match[1] : null;
  }

  /**
   * Extract conversation ID from chat_conversations path
   * Example: "/api/organizations/.../chat_conversations/66e57c37-55df-4794-8420-.../completion" -> "66e57c37-55df-4794-8420-..."
   */
  private extractConversationFromPath(path: string): string | null {
    const match = path.match(/\/chat_conversations\/([a-f0-9-]+)/);
    return match ? match[1] : null;
  }

  /**
   * Track model selection and conversation association
   */
  private trackModelUsage(
    method: string,
    path: string
  ): { model?: string; conversationId?: string } {
    const result: { model?: string; conversationId?: string } = {};

    // Track model selection from GET /model_configs/{model_id}
    if (method === "GET" && path.includes("/model_configs/")) {
      const model = this.extractModelFromPath(path);
      if (model) {
        this.modelTracker.currentModel = model;
        this.modelTracker.lastUpdated = new Date().toISOString();
        result.model = model;
        console.log(`[CONNECTHandler] Model selected: ${model}`);
      }
    }

    // Track conversation creation/usage from POST to chat_conversations
    if (method === "POST" && path.includes("/chat_conversations/")) {
      const convId = this.extractConversationFromPath(path);
      if (convId && this.modelTracker.currentModel) {
        // Associate conversation with current model (if not already tracked)
        if (!this.modelTracker.conversationModels.has(convId)) {
          this.modelTracker.conversationModels.set(convId, this.modelTracker.currentModel);
          console.log(
            `[CONNECTHandler] Conversation ${convId.slice(0, 8)}... -> ${this.modelTracker.currentModel}`
          );
        }
        result.conversationId = convId;
        result.model = this.modelTracker.conversationModels.get(convId);
      }
    }

    return result;
  }

  /**
   * Parse HTTP response status line to extract status code
   * Example: "HTTP/1.1 200 OK" -> { statusCode: 200 }
   */
  private parseResponseLine(data: Buffer | string): {
    statusCode?: number;
    contentLength?: number;
    contentType?: string;
  } {
    const str =
      typeof data === "string"
        ? data.slice(0, 2000)
        : data.toString("utf8", 0, Math.min(2000, data.length));
    const lines = str.split("\r\n");
    const firstLine = lines[0];

    // Parse response line: HTTP/1.1 STATUS_CODE REASON
    const match = firstLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
    const statusCode = match ? Number.parseInt(match[1], 10) : undefined;

    // Parse headers
    let contentLength: number | undefined;
    let contentType: string | undefined;
    for (const line of lines.slice(1)) {
      const lower = line.toLowerCase();
      if (lower.startsWith("content-length:")) {
        contentLength = Number.parseInt(line.slice(15).trim(), 10);
      } else if (lower.startsWith("content-type:")) {
        contentType = line.slice(13).trim();
      }
    }

    return { statusCode, contentLength, contentType };
  }

  /**
   * Check if path is one we want to capture response for
   */
  private shouldCaptureResponse(path: string): boolean {
    // Capture conversation list and detail endpoints to analyze model info
    return path.includes("/chat_conversations") && !path.includes("/completion");
  }

  /**
   * Decompress response body based on content-encoding
   */
  private async decompressBody(data: Buffer, encoding: string): Promise<string> {
    try {
      if (encoding.includes("br")) {
        return zlib.brotliDecompressSync(data).toString("utf8");
      }
      if (encoding.includes("gzip")) {
        return zlib.gunzipSync(data).toString("utf8");
      }
      if (encoding.includes("deflate")) {
        return zlib.inflateSync(data).toString("utf8");
      }
      return data.toString("utf8");
    } catch (err) {
      // Return raw string if decompression fails
      return data.toString("utf8");
    }
  }

  /**
   * Transform Claude Desktop request to Anthropic Messages API format
   * This enables routing to alternative providers like OpenRouter
   */
  transformToAnthropicFormat(
    claudeDesktopRequest: {
      prompt: string;
      parent_message_uuid?: string;
      tools?: Array<{ name: string; description: string; input_schema: unknown }>;
      attachments?: Array<{ file_name: string; extracted_content?: string }>;
    },
    model: string
  ): {
    model: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    max_tokens: number;
    tools?: Array<{ name: string; description: string; input_schema: unknown }>;
    stream: boolean;
  } {
    // Build messages array from prompt
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Add the user's prompt
    let userContent = claudeDesktopRequest.prompt;

    // Include attachment content if present
    if (claudeDesktopRequest.attachments?.length) {
      for (const attachment of claudeDesktopRequest.attachments) {
        if (attachment.extracted_content) {
          userContent = `[Attached file: ${attachment.file_name}]\n${attachment.extracted_content}\n\n${userContent}`;
        }
      }
    }

    messages.push({ role: "user", content: userContent });

    // Transform tools (filter out internal MCP tools)
    const tools = claudeDesktopRequest.tools
      ?.filter(
        (t) =>
          !t.name.includes("aws_marketplace") &&
          t.name !== "web_search" &&
          t.name !== "artifacts" &&
          t.name !== "repl"
      )
      .map((t) => ({
        name: t.name,
        description: t.description || "",
        input_schema: t.input_schema,
      }));

    return {
      model,
      messages,
      max_tokens: 8192,
      tools: tools?.length ? tools : undefined,
      stream: true,
    };
  }

  /**
   * Check if a completion request should be routed to an alternative provider
   */
  shouldRouteRequest(
    path: string,
    conversationId?: string
  ): {
    shouldRoute: boolean;
    sourceModel: string | null;
    targetModel: string | null;
  } {
    // Must be a completion endpoint
    if (!path.includes("/completion")) {
      return { shouldRoute: false, sourceModel: null, targetModel: null };
    }

    // Must have routing enabled
    if (!this.routingConfig.enabled) {
      return { shouldRoute: false, sourceModel: null, targetModel: null };
    }

    // Get the model for this conversation
    let sourceModel: string | null = null;
    if (conversationId) {
      sourceModel = this.modelTracker.conversationModels.get(conversationId) || null;
    }
    if (!sourceModel) {
      sourceModel = this.modelTracker.currentModel;
    }

    if (!sourceModel) {
      return { shouldRoute: false, sourceModel: null, targetModel: null };
    }

    // Check if there's a routing target for this model
    const targetModel = this.routingConfig.modelMap[sourceModel] || null;

    return {
      shouldRoute: targetModel !== null,
      sourceModel,
      targetModel,
    };
  }

  /**
   * Handle decrypted HTTP traffic on TLS socket
   *
   * NEW: Buffers requests, parses them, and decides whether to intercept or forward.
   *
   * @param tlsSocket Decrypted TLS socket from client
   * @param hostname Target hostname for forwarding
   */
  private handleDecryptedHTTP(tlsSocket: tls.TLSSocket, hostname?: string): void {
    const targetHost = hostname || "claude.ai";
    console.log(`[CONNECTHandler] Setting up request interception for ${targetHost}`);

    // Create HTTP request parser for this connection
    const parser = new HTTPRequestParser();

    // Track state for this connection
    let serverConn: tls.TLSSocket | null = null;
    let currentModel: string | undefined;
    let currentConversationId: string | undefined;
    let requestLogged = false;
    let responseLogged = false;
    let captureResponse = false;
    let responseBuffer: Buffer[] = [];
    let contentEncoding = "";

    // Helper to establish server connection for passthrough
    const ensureServerConnection = (): tls.TLSSocket => {
      if (!serverConn) {
        serverConn = tls.connect({
          host: targetHost,
          port: 443,
          servername: targetHost,
        });

        serverConn.on("connect", () => {
          console.log(`[CONNECTHandler] Connected to real server: ${targetHost}`);
        });

        // Handle server responses
        serverConn.on("data", (rawData) => {
          const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

          // Capture response for specific endpoints
          if (captureResponse) {
            if (responseBuffer.length === 0) {
              const headerStr = data.toString("utf8", 0, Math.min(2000, data.length));
              const encodingMatch = headerStr.match(/content-encoding:\s*(\S+)/i);
              if (encodingMatch) {
                contentEncoding = encodingMatch[1].toLowerCase();
              }
            }
            responseBuffer.push(data);
          }

          // Parse and log the first response
          if (!responseLogged && this.trafficCallback) {
            const parsed = this.parseResponseLine(data);
            if (parsed.statusCode) {
              responseLogged = true;
              this.trafficCallback({
                timestamp: new Date().toISOString(),
                direction: "response",
                host: targetHost,
                statusCode: parsed.statusCode,
                contentLength: parsed.contentLength,
                contentType: parsed.contentType,
                model: currentModel,
                conversationId: currentConversationId,
              });
            }
          }

          // Forward to client
          if (!tlsSocket.destroyed) {
            tlsSocket.write(data);
          }
        });

        // When connection closes, analyze captured response
        serverConn.on("end", async () => {
          if (captureResponse && responseBuffer.length > 0) {
            await this.analyzeResponse(responseBuffer, contentEncoding);
          }
          if (!tlsSocket.destroyed) {
            tlsSocket.end();
          }
        });

        serverConn.on("error", (err) => {
          console.error(`[CONNECTHandler] Server connection error: ${err.message}`);
          if (!tlsSocket.destroyed) {
            tlsSocket.destroy();
          }
        });

        serverConn.on("close", () => {
          console.log("[CONNECTHandler] Server connection closed");
        });
      }
      return serverConn;
    };

    // Handle incoming data from client
    tlsSocket.on("data", async (rawData) => {
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

      // Feed data to parser
      parser.feed(data);

      // Check if we have a complete request
      if (parser.isComplete()) {
        try {
          const parsedRequest = parser.parse();
          if (!parsedRequest) {
            // Should not happen if isComplete() returned true, but handle gracefully
            console.error("[CONNECTHandler] Parser reported complete but parse() returned null");
            parser.reset();
            return;
          }

          // Capture auth headers
          if (!this.hasAuth() || !this.capturedAuth.organizationId) {
            this.captureAuthFromRequest(parsedRequest.raw, parsedRequest.path);
          }

          // Track model usage
          const tracking = this.trackModelUsage(parsedRequest.method, parsedRequest.path);
          if (tracking.model) currentModel = tracking.model;
          if (tracking.conversationId) currentConversationId = tracking.conversationId;

          // Setup response capture if needed
          captureResponse = this.shouldCaptureResponse(parsedRequest.path);
          if (captureResponse) {
            responseBuffer = [];
          }

          // Log request
          if (
            !parsedRequest.path.includes("/sentry") &&
            !parsedRequest.path.includes("/icon.png")
          ) {
            const preview =
              parsedRequest.path.length > 60
                ? `${parsedRequest.path.slice(0, 60)}...`
                : parsedRequest.path;
            console.log(
              `[CONNECTHandler] ${parsedRequest.method} ${preview}${currentModel ? ` [${currentModel}]` : ""}`
            );
          }

          if (!requestLogged && this.trafficCallback) {
            requestLogged = true;
            this.trafficCallback({
              timestamp: new Date().toISOString(),
              direction: "request",
              method: parsedRequest.method,
              host: targetHost,
              path: parsedRequest.path,
              contentLength: parsedRequest.body.length,
              contentType: parsedRequest.headers["content-type"],
              model: currentModel,
              conversationId: currentConversationId,
            });
          }

          // Check if we should intercept this request
          const routing = this.shouldRouteRequest(parsedRequest.path, currentConversationId);

          if (routing.shouldRoute && routing.targetModel) {
            // INTERCEPT: Route to alternative provider
            console.log(
              `[CONNECTHandler] 🔀 INTERCEPTING: ${routing.sourceModel} → ${routing.targetModel}`
            );
            await this.handleInterceptedRequest(
              parsedRequest,
              tlsSocket,
              routing.targetModel,
              currentConversationId
            );
          } else {
            // PASSTHROUGH: Forward to Claude
            const conn = ensureServerConnection();
            conn.write(parsedRequest.raw);
          }

          // Reset parser for next request
          parser.reset();
        } catch (err) {
          console.error("[CONNECTHandler] Error processing request:", err);
          // On error, try to forward raw data to server
          if (data.length > 0) {
            const conn = ensureServerConnection();
            conn.write(data);
          }
          parser.reset();
        }
      }
    });

    // Handle errors
    tlsSocket.on("error", (err) => {
      console.error(`[CONNECTHandler] Client socket error: ${err.message}`);
      if (serverConn && !serverConn.destroyed) {
        serverConn.destroy();
      }
    });

    // Handle close
    tlsSocket.on("close", () => {
      console.log("[CONNECTHandler] Client connection closed");
      if (serverConn && !serverConn.destroyed) {
        serverConn.destroy();
      }
    });
  }

  /**
   * Analyze captured response data
   */
  private async analyzeResponse(responseBuffer: Buffer[], contentEncoding: string): Promise<void> {
    try {
      const fullResponse = Buffer.concat(responseBuffer);

      // Find body start (after \r\n\r\n)
      const bodyStart = fullResponse.indexOf("\r\n\r\n");
      if (bodyStart > 0) {
        let body = fullResponse.subarray(bodyStart + 4);

        // Handle chunked transfer encoding
        const headerStr = fullResponse.toString("utf8", 0, bodyStart);
        if (headerStr.toLowerCase().includes("transfer-encoding: chunked")) {
          const bodyStr = body.toString("utf8");
          const chunks: Buffer[] = [];
          let pos = 0;
          while (pos < bodyStr.length) {
            const lineEnd = bodyStr.indexOf("\r\n", pos);
            if (lineEnd === -1) break;
            const chunkSize = Number.parseInt(bodyStr.slice(pos, lineEnd), 16);
            if (chunkSize === 0) break;
            chunks.push(Buffer.from(bodyStr.slice(lineEnd + 2, lineEnd + 2 + chunkSize)));
            pos = lineEnd + 2 + chunkSize + 2;
          }
          body = Buffer.concat(chunks);
        }

        // Decompress
        const decompressed = await this.decompressBody(body, contentEncoding);

        // Parse conversation list to populate model tracker
        if (decompressed.startsWith("[")) {
          try {
            const conversations = JSON.parse(decompressed) as Array<{
              uuid?: string;
              model?: string | null;
              name?: string;
            }>;

            let added = 0;
            for (const conv of conversations) {
              if (conv.uuid && conv.model) {
                this.modelTracker.conversationModels.set(conv.uuid, conv.model);
                added++;
              }
            }

            if (added > 0) {
              this.modelTracker.lastUpdated = new Date().toISOString();
              console.log(`[CONNECTHandler] Loaded ${added} conversation→model mappings from list`);
            }
          } catch (parseErr) {
            console.error("[CONNECTHandler] Failed to parse conversation list:", parseErr);
          }
        }
      }
    } catch (err) {
      console.error("[CONNECTHandler] Error analyzing response:", err);
    }
  }

  /**
   * Handle an intercepted completion request by routing to alternative provider
   */
  private async handleInterceptedRequest(
    parsedRequest: ParsedHTTPRequest,
    tlsSocket: tls.TLSSocket,
    targetModel: string,
    conversationId?: string
  ): Promise<void> {
    try {
      // Parse request body as JSON
      const bodyStr = parsedRequest.body.toString("utf8");
      if (!bodyStr) {
        throw new Error("Empty request body");
      }

      const claudeDesktopRequest = JSON.parse(bodyStr);

      // Save for debugging
      this.saveCompletionRequestDebug(claudeDesktopRequest, parsedRequest.path, conversationId);

      // Transform to Anthropic API format
      const anthropicRequest = this.transformToAnthropicFormat(claudeDesktopRequest, targetModel);

      // Save transformed request for debugging
      const timestamp = Date.now();
      const filename = `/tmp/transformed_${conversationId?.slice(0, 8) || "unknown"}_${timestamp}.json`;
      fs.writeFileSync(filename, JSON.stringify(anthropicRequest, null, 2));
      console.log(`[CONNECTHandler] Saved transformed request to ${filename}`);

      // Call provider API
      const response = await this.callProviderAPI(targetModel, anthropicRequest);

      // Transform and stream response back to client
      await this.streamTransformedResponse(tlsSocket, response, targetModel);
    } catch (err) {
      console.error("[CONNECTHandler] Interception failed, falling back to Claude:", err);

      // Fallback: forward original request to Claude
      const serverConn = tls.connect({
        host: "claude.ai",
        port: 443,
        servername: "claude.ai",
      });

      serverConn.on("connect", () => {
        serverConn.write(parsedRequest.raw);
        serverConn.pipe(tlsSocket);
      });

      serverConn.on("error", (fallbackErr) => {
        console.error("[CONNECTHandler] Fallback failed:", fallbackErr);
        if (!tlsSocket.destroyed) {
          this.writeErrorResponse(tlsSocket, err);
        }
      });

      // Log fallback
      const logFilename = `/tmp/fallback_${Date.now()}.json`;
      fs.writeFileSync(
        logFilename,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            targetModel,
            error: err instanceof Error ? err.message : String(err),
            conversationId,
          },
          null,
          2
        )
      );
    }
  }

  /**
   * Save completion request for debugging
   */
  private saveCompletionRequestDebug(
    request: unknown,
    path: string,
    conversationId?: string
  ): void {
    try {
      const timestamp = Date.now();
      const pathSlug = path.includes("/completion") ? "completion" : "request";
      const filename = `/tmp/${pathSlug}_${conversationId?.slice(0, 8) || "unknown"}_${timestamp}.json`;
      fs.writeFileSync(filename, JSON.stringify(request, null, 2));
      console.log(`[CONNECTHandler] Saved completion request to ${filename}`);
    } catch (err) {
      console.error("[CONNECTHandler] Error saving completion request:", err);
    }
  }

  /**
   * Call provider API (OpenRouter, OpenAI, Gemini, etc.)
   */
  private async callProviderAPI(targetModel: string, anthropicRequest: unknown): Promise<Response> {
    // Determine provider from model prefix
    let apiUrl: string;
    let apiKey: string | undefined;
    let headers: Record<string, string>;

    // OpenRouter (default for most models)
    if (targetModel.includes("/")) {
      apiUrl = "https://openrouter.ai/api/v1/chat/completions";
      apiKey = this.apiKeys.openrouter;
      if (!apiKey) {
        throw new Error("OpenRouter API key not configured");
      }
      headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://claudish.app",
        "X-Title": "Claudish",
      };
    } else {
      throw new Error(`Unsupported model format: ${targetModel}`);
    }

    // Transform Anthropic format to OpenAI format
    const req = anthropicRequest as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
      tools?: Array<{ name: string; description: string; input_schema: unknown }>;
      stream: boolean;
    };

    const openaiPayload = {
      model: targetModel,
      messages: req.messages,
      max_tokens: req.max_tokens,
      stream: true,
      tools: req.tools?.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
    };

    console.log(`[CONNECTHandler] Calling ${apiUrl} with model ${targetModel}`);

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(openaiPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Provider API error: ${response.status} ${errorText}`);
    }

    return response;
  }

  /**
   * Stream transformed response back to client in Claude Desktop format
   */
  private async streamTransformedResponse(
    tlsSocket: tls.TLSSocket,
    providerResponse: Response,
    targetModel: string
  ): Promise<void> {
    // Write HTTP response headers
    tlsSocket.write(
      "HTTP/1.1 200 OK\r\n" +
        "Content-Type: text/event-stream\r\n" +
        "Cache-Control: no-cache\r\n" +
        "Connection: keep-alive\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "\r\n"
    );

    const decoder = new TextDecoder();

    // Generate message ID
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // State for transformation
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    let textStarted = false;
    let textIdx = -1;
    let thinkingStarted = false;
    const thinkingIdx = -1;
    let curIdx = 0;
    const tools = new Map<
      number,
      {
        id: string;
        name: string;
        blockIndex: number;
        started: boolean;
        closed: boolean;
        arguments: string;
      }
    >();

    // Helper to write SSE event
    const writeEvent = (event: string, data: unknown) => {
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const chunkSize = Buffer.byteLength(chunk, "utf8").toString(16);
      tlsSocket.write(`${chunkSize}\r\n${chunk}\r\n`);
    };

    // Send message_start
    writeEvent("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: targetModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    });

    writeEvent("ping", { type: "ping" });

    try {
      const reader = providerResponse.body!.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim() || !line.startsWith("data: ")) continue;
          const dataStr = line.slice(6);
          if (dataStr === "[DONE]") {
            break;
          }

          try {
            const chunk = JSON.parse(dataStr);
            if (chunk.usage) usage = chunk.usage;

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // Handle text content
            const txt = delta.content || "";
            if (txt) {
              // Close thinking block before starting text
              if (thinkingStarted) {
                writeEvent("content_block_stop", {
                  type: "content_block_stop",
                  index: thinkingIdx,
                });
                thinkingStarted = false;
              }
              if (!textStarted) {
                textIdx = curIdx++;
                writeEvent("content_block_start", {
                  type: "content_block_start",
                  index: textIdx,
                  content_block: { type: "text", text: "" },
                });
                textStarted = true;
              }
              writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: textIdx,
                delta: { type: "text_delta", text: txt },
              });
            }

            // Handle tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                let t = tools.get(idx);

                if (tc.function?.name) {
                  if (!t) {
                    // Close previous blocks
                    if (thinkingStarted) {
                      writeEvent("content_block_stop", {
                        type: "content_block_stop",
                        index: thinkingIdx,
                      });
                      thinkingStarted = false;
                    }
                    if (textStarted) {
                      writeEvent("content_block_stop", {
                        type: "content_block_stop",
                        index: textIdx,
                      });
                      textStarted = false;
                    }

                    t = {
                      id: tc.id || `tool_${Date.now()}_${idx}`,
                      name: tc.function.name,
                      blockIndex: curIdx++,
                      started: false,
                      closed: false,
                      arguments: "",
                    };
                    tools.set(idx, t);
                  }

                  if (!t.started) {
                    writeEvent("content_block_start", {
                      type: "content_block_start",
                      index: t.blockIndex,
                      content_block: { type: "tool_use", id: t.id, name: t.name },
                    });
                    t.started = true;
                  }
                }

                if (tc.function?.arguments && t) {
                  t.arguments += tc.function.arguments;
                  writeEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: t.blockIndex,
                    delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                  });
                }
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }

      // Close any open blocks
      if (thinkingStarted) {
        writeEvent("content_block_stop", { type: "content_block_stop", index: thinkingIdx });
      }
      if (textStarted) {
        writeEvent("content_block_stop", { type: "content_block_stop", index: textIdx });
      }
      for (const [_, t] of tools) {
        if (t.started && !t.closed) {
          writeEvent("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
        }
      }

      // Send final events
      writeEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: usage?.completion_tokens || 0 },
      });

      writeEvent("message_stop", { type: "message_stop" });

      // Write final chunk
      tlsSocket.write("data: [DONE]\n\n\n");
      tlsSocket.write("0\r\n\r\n");

      console.log(
        `[CONNECTHandler] ✅ Interception complete. Tokens: in=${usage?.prompt_tokens || 0}, out=${usage?.completion_tokens || 0}`
      );
    } catch (err) {
      console.error("[CONNECTHandler] Error streaming response:", err);
      writeEvent("error", { type: "error", error: { type: "api_error", message: String(err) } });
      tlsSocket.write("0\r\n\r\n");
    }
  }

  /**
   * Write error response to client
   */
  private writeErrorResponse(tlsSocket: tls.TLSSocket, err: unknown): void {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const response = JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: errorMsg,
      },
    });

    tlsSocket.write(
      `HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(response)}\r\nConnection: close\r\n\r\n${response}`
    );
    tlsSocket.end();
  }

  /**
   * Send error response and close socket
   *
   * @param socket Client socket
   * @param message Error message
   */
  private respondError(socket: net.Socket, message: string): void {
    console.error(`[CONNECTHandler] ${message}`);

    socket.write(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message}`
    );

    socket.end();
  }
}
