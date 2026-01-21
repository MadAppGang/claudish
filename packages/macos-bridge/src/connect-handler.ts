import * as fs from "node:fs";
import type * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import type { CertificateManager } from "./certificate-manager";
import { CycleTLSManager } from "./cycletls-manager";
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
  private cycleTLSManager: CycleTLSManager | null = null;

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

  /**
   * Store for injected messages per conversation
   * Key: conversation UUID, Value: array of messages to inject
   */
  private injectedMessages: Map<
    string,
    Array<{
      uuid: string;
      text: string;
      content: Array<{
        start_timestamp: string;
        stop_timestamp: string;
        type: string;
        text: string;
        citations: unknown[];
      }>;
      sender: "human" | "assistant";
      index: number;
      created_at: string;
      updated_at: string;
      truncated: boolean;
      attachments: unknown[];
      files: unknown[];
      files_v2: unknown[];
      sync_sources: unknown[];
      parent_message_uuid: string;
    }>
  > = new Map();

  constructor(
    certManager: CertificateManager,
    _requestHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
    trafficCallback?: TrafficCallback,
    cycleTLSManager?: CycleTLSManager
  ) {
    this.certManager = certManager;
    // Note: requestHandler reserved for future HTTP routing support
    this.trafficCallback = trafficCallback;
    this.cycleTLSManager = cycleTLSManager || null;
  }

  /**
   * Set CycleTLS manager for Chrome-fingerprinted passthrough requests
   */
  setCycleTLSManager(manager: CycleTLSManager): void {
    this.cycleTLSManager = manager;
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
    const msg = `[CONNECTHandler] Routing ${config.enabled ? "enabled" : "disabled"}, ${Object.keys(config.modelMap).length} mappings: ${JSON.stringify(config.modelMap)}`;
    console.log(msg);
    // Debug: write to file
    fs.appendFileSync("/tmp/claudish-routing.log", `${new Date().toISOString()} ${msg}\n`);
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
    this.upgradeTLS(hostname, clientSocket, head).catch((err) => {
      console.error(`[CONNECTHandler] TLS upgrade failed for ${hostname}:`, err);
      clientSocket.destroy();
    });
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
        ALPNProtocols: ["http/1.1"], // Force HTTP/1.1 to avoid HTTP/2 parsing issues
      });

      tlsServer.on("secureConnection", (tlsSocket: tls.TLSSocket) => {
        console.log(`[CONNECTHandler] TLS handshake completed for ${hostname}`);
        this.handleDecryptedHTTP(tlsSocket, hostname);
      });

      tlsServer.on("tlsClientError", (err) => {
        console.error(`[CONNECTHandler] TLS_CLIENT_ERROR for ${hostname}:`, err.message);
      });

      tlsServer.on("error", (err) => {
        console.error(`[CONNECTHandler] TLS_SERVER_ERROR for ${hostname}:`, err.message);
        clientSocket.destroy();
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
      if (convId) {
        // Always return conversationId for POST requests (needed for message storage)
        result.conversationId = convId;

        // Associate conversation with current model (if available)
        if (this.modelTracker.currentModel) {
          if (!this.modelTracker.conversationModels.has(convId)) {
            this.modelTracker.conversationModels.set(convId, this.modelTracker.currentModel);
            console.log(
              `[CONNECTHandler] Conversation ${convId.slice(0, 8)}... -> ${this.modelTracker.currentModel}`
            );
          }
          result.model = this.modelTracker.conversationModels.get(convId);
        }
      }
    }

    // Also extract conversation ID from GET requests (for sync interception)
    if (method === "GET" && path.includes("/chat_conversations/")) {
      const convId = this.extractConversationFromPath(path);
      if (convId) {
        result.conversationId = convId;
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
    model: string,
    conversationId?: string
  ): {
    model: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    max_tokens: number;
    tools?: Array<{ name: string; description: string; input_schema: unknown }>;
    stream: boolean;
  } {
    // Build messages array from prompt
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Add conversation history if available
    if (conversationId) {
      const history = this.injectedMessages.get(conversationId);
      if (history && history.length > 0) {
        console.log(`[CONNECTHandler] 📚 Including ${history.length} messages from conversation history`);
        for (const msg of history) {
          const text = msg.content[0]?.text || "";
          if (text) {
            messages.push({
              role: msg.sender === "human" ? "user" : "assistant",
              content: text,
            });
          }
        }
      }
    }

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

    // Check if there's a routing target for this model
    let targetModel = sourceModel ? (this.routingConfig.modelMap[sourceModel] || null) : null;

    // FALLBACK: If we don't know the source model but routing is enabled,
    // check if all targets are the same (common case: route everything to one model)
    if (!targetModel && !sourceModel) {
      const targets = Object.values(this.routingConfig.modelMap);
      const uniqueTargets = [...new Set(targets)];
      if (uniqueTargets.length === 1) {
        // All models route to the same target, use it as fallback
        targetModel = uniqueTargets[0];
        sourceModel = "unknown";
        console.log(`[CONNECTHandler] 🎯 Model unknown but all routes go to ${targetModel}, using fallback`);
      } else if (targets.length > 0) {
        // Multiple targets, use the first one as best guess
        targetModel = targets[0];
        sourceModel = "unknown";
        console.log(`[CONNECTHandler] 🎯 Model unknown, using first target as fallback: ${targetModel}`);
      }
    }

    return {
      shouldRoute: targetModel !== null,
      sourceModel,
      targetModel,
    };
  }

  /**
   * Forward streaming request (like completions) via native TLS
   * Pipes data through in real-time without buffering
   */
  private async forwardStreamingRequest(
    parsedRequest: ParsedHTTPRequest,
    tlsSocket: tls.TLSSocket,
    targetHost: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[CONNECTHandler] 🌊 Streaming request to ${targetHost}${parsedRequest.path.substring(0, 50)}...`);

      // Build modified request without Accept-Encoding
      const lines = parsedRequest.raw.toString('utf8').split('\r\n');
      const modifiedLines = lines.filter(line => {
        const lower = line.toLowerCase();
        return !lower.startsWith('accept-encoding:');
      });
      const modifiedRequest = modifiedLines.join('\r\n');

      // Connect to real server
      const serverConn = tls.connect({
        host: targetHost,
        port: 443,
        servername: targetHost,
        ALPNProtocols: ["http/1.1"],
      });

      serverConn.on("secureConnect", () => {
        console.log(`[CONNECTHandler] 🔐 Streaming connection established to ${targetHost}`);
        serverConn.write(modifiedRequest);
      });

      // Pipe server response directly to client (real-time streaming)
      serverConn.on("data", (data: Buffer) => {
        if (!tlsSocket.destroyed) {
          tlsSocket.write(data);
        }
      });

      serverConn.on("end", () => {
        console.log(`[CONNECTHandler] 🏁 Streaming response ended`);
        if (!tlsSocket.destroyed) {
          tlsSocket.end();
        }
        resolve();
      });

      serverConn.on("error", (err) => {
        console.error(`[CONNECTHandler] Streaming error: ${err.message}`);
        if (!tlsSocket.destroyed) {
          tlsSocket.destroy();
        }
        reject(err);
      });

      // If client disconnects, close server connection too
      tlsSocket.on("close", () => {
        if (!serverConn.destroyed) {
          serverConn.destroy();
        }
      });

      tlsSocket.on("error", () => {
        if (!serverConn.destroyed) {
          serverConn.destroy();
        }
      });
    });
  }

  /**
   * Forward request via native TLS with modified headers
   * Strips Accept-Encoding to get uncompressed responses
   * Saves all traffic to files for debugging
   */
  private async forwardViaNativeTLS(
    parsedRequest: ParsedHTTPRequest,
    tlsSocket: tls.TLSSocket,
    targetHost: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now();
      const logPrefix = `/tmp/traffic_${timestamp}`;

      // Build modified request without Accept-Encoding
      const lines = parsedRequest.raw.toString('utf8').split('\r\n');
      const modifiedLines = lines.filter(line => {
        const lower = line.toLowerCase();
        return !lower.startsWith('accept-encoding:');
      });
      const modifiedRequest = modifiedLines.join('\r\n');

      // Save request to file
      fs.writeFileSync(`${logPrefix}_request.txt`, modifiedRequest);
      console.log(`[CONNECTHandler] Saved request to ${logPrefix}_request.txt`);

      // Connect to real server
      const serverConn = tls.connect({
        host: targetHost,
        port: 443,
        servername: targetHost,
        ALPNProtocols: ["http/1.1"],
      });

      const responseChunks: Buffer[] = [];
      let firstChunkLogged = false;

      serverConn.on("secureConnect", () => {
        console.log(`[CONNECTHandler] Native TLS connected to ${targetHost}`);
        serverConn.write(modifiedRequest);
      });

      serverConn.on("data", (data: Buffer) => {
        responseChunks.push(data);

        // Log the first chunk with headers
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          const separator = Buffer.from('\r\n\r\n');
          const headerEnd = data.indexOf(separator);
          if (headerEnd > 0) {
            const headers = data.subarray(0, headerEnd).toString('utf8');
            fs.writeFileSync(`${logPrefix}_response_headers.txt`, headers);
            console.log(`[CONNECTHandler] Response headers:\n${headers.substring(0, 500)}`);

            // Save body preview
            const bodyStart = headerEnd + 4;
            const bodyPreview = data.subarray(bodyStart, bodyStart + 500).toString('utf8');
            fs.writeFileSync(`${logPrefix}_body_preview.txt`, bodyPreview);
            console.log(`[CONNECTHandler] Body preview: ${bodyPreview.substring(0, 200)}`);
          }
        }

        // Forward to client immediately
        if (!tlsSocket.destroyed) {
          tlsSocket.write(data);
        }
      });

      serverConn.on("end", () => {
        // Save complete response to file
        const fullResponse = Buffer.concat(responseChunks);
        fs.writeFileSync(`${logPrefix}_response.bin`, fullResponse);
        console.log(`[CONNECTHandler] Saved full response (${fullResponse.length} bytes) to ${logPrefix}_response.bin`);

        if (!tlsSocket.destroyed) {
          tlsSocket.end();
        }
        resolve();
      });

      serverConn.on("error", (err) => {
        console.error(`[CONNECTHandler] Native TLS error: ${err.message}`);
        reject(err);
      });

      tlsSocket.on("close", () => {
        serverConn.destroy();
      });
    });
  }

  /**
   * Forward conversation GET request and inject stored messages into the response
   * This prevents Claude Desktop from detecting "message loss" when we intercept completion requests
   */
  private async forwardWithMessageInjection(
    parsedRequest: ParsedHTTPRequest,
    tlsSocket: tls.TLSSocket,
    targetHost: string,
    conversationId: string
  ): Promise<void> {
    if (!this.cycleTLSManager) {
      throw new Error("CycleTLS manager not available for message injection");
    }

    const injectedMsgs = this.injectedMessages.get(conversationId);
    if (!injectedMsgs || injectedMsgs.length === 0) {
      // No messages to inject, just forward normally
      return this.forwardViaCycleTLS(parsedRequest, tlsSocket, targetHost);
    }

    try {
      const url = `https://${targetHost}${parsedRequest.path}`;

      console.log(`[CONNECTHandler] 🔀 Fetching conversation for message injection: ${parsedRequest.path.slice(0, 80)}`);

      // Remove headers that CycleTLS manages
      const headersWithoutCompression: Record<string, string> = {};
      const skipHeaders = new Set([
        "accept-encoding",
        "user-agent",
        "connection",
        "host",
        "content-length",
      ]);
      for (const [key, value] of Object.entries(parsedRequest.headers)) {
        const lowerKey = key.toLowerCase();
        if (!skipHeaders.has(lowerKey)) {
          headersWithoutCompression[key] = value;
        }
      }

      // Make the request via CycleTLS
      const response = await this.cycleTLSManager.request(url, {
        method: parsedRequest.method,
        headers: headersWithoutCompression,
        body: parsedRequest.body.length > 0 ? parsedRequest.body.toString("utf8") : undefined,
      });

      if (response.status !== 200) {
        // Non-200 response, just forward as-is
        console.log(`[CONNECTHandler] Conversation fetch returned ${response.status}, forwarding without injection`);
        const responseStr = this.buildHTTPResponse(response.status, response.headers, response.body);
        tlsSocket.write(responseStr);
        return;
      }

      // Parse the JSON response
      let conversationData: { chat_messages?: unknown[]; [key: string]: unknown };
      try {
        conversationData = JSON.parse(response.body);
      } catch {
        // Not JSON, forward as-is
        console.log("[CONNECTHandler] Conversation response not JSON, forwarding without injection");
        const responseStr = this.buildHTTPResponse(response.status, response.headers, response.body);
        tlsSocket.write(responseStr);
        return;
      }

      // Debug: Log original server response structure
      console.log(`[CONNECTHandler] 🔍 Original server response has ${conversationData.chat_messages?.length || 0} messages`);
      if (conversationData.chat_messages?.[0]) {
        const serverMsg = conversationData.chat_messages[0] as Record<string, unknown>;
        console.log(`[CONNECTHandler] 🔍 Server message keys: ${Object.keys(serverMsg).join(', ')}`);
        // Save first server message to file for comparison
        try {
          const fs = require('fs');
          fs.writeFileSync('/tmp/server_message_sample.json', JSON.stringify(serverMsg, null, 2));
          console.log(`[CONNECTHandler] 🔍 Server message sample saved to /tmp/server_message_sample.json`);
        } catch (e) { /* ignore */ }
      }

      // Inject our messages into chat_messages array
      if (Array.isArray(conversationData.chat_messages)) {
        // Check if messages are already there (by UUID)
        const existingUuids = new Set(
          conversationData.chat_messages.map((m: { uuid?: string }) => m.uuid)
        );

        for (const msg of injectedMsgs) {
          if (!existingUuids.has(msg.uuid)) {
            conversationData.chat_messages.push(msg);
            console.log(
              `[CONNECTHandler] 💉 Injected ${msg.sender} message ${msg.uuid.slice(0, 8)} into conversation`
            );
          }
        }

        // Sort messages by index to maintain order
        conversationData.chat_messages.sort(
          (a: { index?: number }, b: { index?: number }) => (a.index || 0) - (b.index || 0)
        );
      } else {
        // No chat_messages array, create one with our messages
        conversationData.chat_messages = [...injectedMsgs];
        console.log(`[CONNECTHandler] 💉 Created chat_messages array with ${injectedMsgs.length} injected messages`);
      }

      // CRITICAL: Set current_leaf_message_uuid to the last message
      // This tells Claude Desktop which message is the "current" state of the conversation
      if (conversationData.chat_messages && conversationData.chat_messages.length > 0) {
        const lastMessage = conversationData.chat_messages[conversationData.chat_messages.length - 1];
        if (lastMessage?.uuid) {
          conversationData.current_leaf_message_uuid = lastMessage.uuid;
          console.log(`[CONNECTHandler] 🔗 Set current_leaf_message_uuid to ${lastMessage.uuid.slice(0, 8)}`);
        }
      }

      // Debug: Save modified conversation response for analysis (AFTER injection)
      try {
        const fs = require('fs');
        fs.writeFileSync('/tmp/conversation_response_modified.json', JSON.stringify(conversationData, null, 2));
        console.log(`[CONNECTHandler] 🔍 Modified conversation saved with ${conversationData.chat_messages?.length || 0} messages`);
      } catch (e) { /* ignore */ }

      // Serialize the modified response
      const modifiedBody = JSON.stringify(conversationData);

      // Update Content-Length header (delete all case variants first)
      const modifiedHeaders = { ...response.headers };
      // Remove all Content-Length variants to avoid duplicates
      delete modifiedHeaders["Content-Length"];
      delete modifiedHeaders["content-length"];
      delete modifiedHeaders["CONTENT-LENGTH"];
      // Set the correct content length
      modifiedHeaders["Content-Length"] = String(Buffer.byteLength(modifiedBody));
      // Remove content-encoding since we're sending uncompressed
      delete modifiedHeaders["content-encoding"];
      delete modifiedHeaders["Content-Encoding"];

      // Build and send response
      const responseStr = this.buildHTTPResponse(200, modifiedHeaders, modifiedBody);
      console.log(`[CONNECTHandler] 📤 Sending modified sync response (${modifiedBody.length} bytes)`);

      // Debug: Save exact HTTP response being sent
      try {
        const fs = require('fs');
        fs.writeFileSync('/tmp/http_response_sent.txt', responseStr);
        console.log(`[CONNECTHandler] 🔍 Full HTTP response saved to /tmp/http_response_sent.txt (${responseStr.length} total bytes)`);
      } catch (e) { /* ignore */ }

      tlsSocket.write(responseStr);

      console.log(
        `[CONNECTHandler] ✅ Message injection complete. Conversation now has ${conversationData.chat_messages?.length || 0} messages`
      );

      // Debug: Log first injected message structure
      if (conversationData.chat_messages?.[0]) {
        const firstMsg = conversationData.chat_messages[0];
        console.log(`[CONNECTHandler] 🔍 First message structure: uuid=${firstMsg.uuid?.slice(0, 8)}, sender=${firstMsg.sender}, index=${firstMsg.index}, parent=${firstMsg.parent_message_uuid?.slice(0, 8)}`);
      }
    } catch (err) {
      console.error("[CONNECTHandler] Message injection failed, falling back to normal forward:", err);
      // Fallback to normal CycleTLS forward
      await this.forwardViaCycleTLS(parsedRequest, tlsSocket, targetHost);
    }
  }

  /**
   * Build HTTP response string from status, headers, and body
   */
  private buildHTTPResponse(
    status: number,
    headers: Record<string, string>,
    body: string
  ): string {
    const statusText = status === 200 ? "OK" : status === 404 ? "Not Found" : "Error";
    let response = `HTTP/1.1 ${status} ${statusText}\r\n`;

    for (const [key, value] of Object.entries(headers)) {
      // Skip transfer-encoding as we're sending full body
      if (key.toLowerCase() === "transfer-encoding") continue;
      response += `${key}: ${value}\r\n`;
    }

    response += "\r\n";
    response += body;

    return response;
  }

  /**
   * Forward request via CycleTLS with Chrome fingerprint
   * Used for passthrough requests to claude.ai to bypass Cloudflare detection
   */
  private async forwardViaCycleTLS(
    parsedRequest: ParsedHTTPRequest,
    tlsSocket: tls.TLSSocket,
    targetHost: string
  ): Promise<void> {
    if (!this.cycleTLSManager) {
      throw new Error("CycleTLS manager not available");
    }

    try {
      // Build full URL
      const url = `https://${targetHost}${parsedRequest.path}`;

      console.log(`[CONNECTHandler] 🚀 Forwarding via CycleTLS: ${parsedRequest.method} ${parsedRequest.path}`);

      // Debug: log POST body
      if (parsedRequest.method === "POST") {
        console.log(`[CONNECTHandler] POST body (${parsedRequest.body.length} bytes): ${parsedRequest.body.toString("utf8").substring(0, 200)}`);
      }

      // Remove headers that CycleTLS manages or that could cause issues
      const headersWithoutCompression: Record<string, string> = {};
      const skipHeaders = new Set([
        'accept-encoding',  // CycleTLS handles decompression
        'user-agent',       // CycleTLS sets Chrome User-Agent
        'connection',       // CycleTLS manages connections
        'host',             // CycleTLS derives from URL
        'content-length',   // CycleTLS computes from body
      ]);
      for (const [key, value] of Object.entries(parsedRequest.headers)) {
        const lowerKey = key.toLowerCase();
        if (skipHeaders.has(lowerKey)) {
          continue;
        }
        headersWithoutCompression[key] = value;
      }

      // Ensure Content-Type is set for POST requests with JSON body
      if (parsedRequest.method === "POST") {
        const hasContentType = Object.keys(headersWithoutCompression).some(k => k.toLowerCase() === "content-type");
        console.log(`[CONNECTHandler] POST check: hasContentType=${hasContentType}, keys=${Object.keys(headersWithoutCompression).join(",")}`);
        if (!hasContentType) {
          const bodyStr = parsedRequest.body.toString("utf8").trim();
          if (bodyStr.startsWith("{") || bodyStr.startsWith("[")) {
            headersWithoutCompression["Content-Type"] = "application/json";
            console.log(`[CONNECTHandler] Added missing Content-Type: application/json`);
          }
        }
      }

      // Debug: log headers being sent
      if (parsedRequest.method === "POST") {
        console.log(`[CONNECTHandler] Headers for POST: ${JSON.stringify(headersWithoutCompression).substring(0, 500)}`);
      }

      // Make request via CycleTLS
      const response = await this.cycleTLSManager.request(url, {
        method: parsedRequest.method,
        headers: headersWithoutCompression,
        body: parsedRequest.body.length > 0 ? parsedRequest.body.toString("utf8") : undefined,
      });

      console.log(`[CONNECTHandler] ✅ CycleTLS response: ${response.status}`);

      // Debug: Save RSC responses to file for inspection
      if (parsedRequest.path.includes("_rsc=") && response.body) {
        const convMatch = parsedRequest.path.match(/\/chat\/([a-f0-9-]+)/);
        const convId = convMatch?.[1]?.slice(0, 8) || "unknown";
        const filename = `/tmp/rsc_${convId}_${Date.now()}.txt`;
        fs.writeFileSync(filename, response.body);
        console.log(`[CONNECTHandler] 📄 Saved RSC response to ${filename} (${response.body.length} bytes)`);
      }

      // Build HTTP response
      const statusText = this.getStatusText(response.status);
      const statusLine = `HTTP/1.1 ${response.status} ${statusText}\r\n`;

      // Build headers - CycleTLS returns arrays, flatten them
      // Skip Content-Encoding since CycleTLS already decompresses the body
      const headers = Object.entries(response.headers)
        .filter(([k]) => k.toLowerCase() !== 'content-encoding')
        .map(([k, v]) => {
          // CycleTLS returns header values as arrays - take first value
          const value = Array.isArray(v) ? v[0] : String(v);
          const sanitized = value.replace(/[\r\n]/g, '');
          return `${k}: ${sanitized}`;
        })
        .join("\r\n");

      const httpResponse = `${statusLine}${headers}\r\n\r\n`;

      // Debug: log what we're sending
      console.log(`[CONNECTHandler] Response headers:\n${headers.substring(0, 500)}`);
      console.log(`[CONNECTHandler] Body length: ${response.body?.length || 0}`);

      // Write response to client (check socket state first)
      if (tlsSocket.destroyed) {
        throw new Error("Client socket destroyed before response could be written");
      }
      tlsSocket.write(httpResponse);
      if (response.body) {
        tlsSocket.write(response.body);
      }
    } catch (err) {
      console.error("[CONNECTHandler] CycleTLS forward failed:", err);
      throw err;
    }
  }

  /**
   * Get HTTP status text for status code
   */
  private getStatusText(statusCode: number): string {
    const statusTexts: Record<number, string> = {
      200: "OK",
      201: "Created",
      204: "No Content",
      301: "Moved Permanently",
      302: "Found",
      304: "Not Modified",
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
    };
    return statusTexts[statusCode] || "Unknown";
  }

  /**
   * Handle decrypted HTTP traffic on TLS socket
   *
   * NEW: Buffers requests, parses them, and decides whether to intercept or forward.
   * Detects WebSocket upgrades and switches to pure passthrough mode.
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
    let isWebSocket = false; // Track if connection has been upgraded to WebSocket

    // Helper to establish server connection for passthrough
    const ensureServerConnection = (): tls.TLSSocket => {
      if (!serverConn) {
        serverConn = tls.connect({
          host: targetHost,
          port: 443,
          servername: targetHost,
          ALPNProtocols: ["http/1.1"], // Force HTTP/1.1 for upstream too
        });

        serverConn.on("connect", () => {
          console.log(`[CONNECTHandler] ✅ Connected to real server: ${targetHost}`);
        });

        serverConn.on("secureConnect", () => {
          console.log(`[CONNECTHandler] 🔐 TLS handshake complete with ${targetHost}`);
        });

        // Handle server responses
        serverConn.on("data", (rawData) => {
          const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

          // Log WebSocket upgrade responses (101)
          if (isWebSocket || data.toString("utf8", 0, 30).includes("101")) {
            console.log(`[CONNECTHandler] 📥 Server response (${data.length} bytes, isWS=${isWebSocket})`);
          }

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

              // Detailed logging for 403 responses
              if (parsed.statusCode === 403) {
                console.log(`[CONNECTHandler] ⚠️ 403 Response detected!`);
                const headerStr = data.toString("utf8", 0, Math.min(2000, data.length));
                console.log(`[CONNECTHandler] Response headers:\n${headerStr.split('\r\n\r\n')[0]}`);
                const bodyStart = headerStr.indexOf('\r\n\r\n');
                if (bodyStart > 0) {
                  const body = headerStr.slice(bodyStart + 4, bodyStart + 504);
                  console.log(`[CONNECTHandler] Response body preview:\n${body}`);
                }
              }
            }
          }

          // Forward to client
          if (!tlsSocket.destroyed) {
            tlsSocket.write(data);
          }
        });

        // When connection closes, analyze captured response
        serverConn.on("end", async () => {
          try {
            if (captureResponse && responseBuffer.length > 0) {
              await this.analyzeResponse(responseBuffer, contentEncoding);
            }
            if (!tlsSocket.destroyed) {
              tlsSocket.end();
            }
          } catch (err) {
            console.error("[CONNECTHandler] Error in serverConn 'end' handler:", err);
            if (!tlsSocket.destroyed) {
              tlsSocket.destroy();
            }
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
      try {
        const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);

        // If already in WebSocket mode, just pipe through without parsing
        if (isWebSocket) {
          const conn = ensureServerConnection();
          conn.write(data);
          return;
        }

        // Feed data to parser
        parser.feed(data);

        // Debug: Log parsing state for large requests
        const parserState = parser.getState();
        if (parserState.method === "POST" || data.length > 1000) {
          console.log(`[CONNECTHandler] 📦 Data chunk: ${data.length} bytes, method=${parserState.method || 'unknown'}, isComplete=${parser.isComplete()}, contentLength=${parserState.contentLength}, received=${parserState.bodyReceived}`);
        }

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

            // Detect WebSocket upgrade request
            const upgradeHeader = parsedRequest.headers["upgrade"]?.toLowerCase();
            const isWebSocketRequest = upgradeHeader === "websocket";
            if (isWebSocketRequest) {
              console.log(`[CONNECTHandler] 🔌 WebSocket upgrade detected for ${parsedRequest.path}`);
              console.log(`[CONNECTHandler] 📤 Forwarding WS upgrade request (${parsedRequest.raw.length} bytes)`);
              isWebSocket = true; // Switch to passthrough mode after this request
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
              const isCompletion = parsedRequest.path.includes("/completion");
              console.log(
                `[CONNECTHandler] ${parsedRequest.method} ${preview}${currentModel ? ` [${currentModel}]` : ""}${isWebSocketRequest ? " [WS]" : ""}${isCompletion ? " [COMPLETION]" : ""}`
              );
              if (isCompletion) {
                console.log(`[CONNECTHandler] 🎯 Completion request detected! Body length: ${parsedRequest.body.length}`);
              }
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
              // PASSTHROUGH: Forward to target
              if (targetHost.includes("claude.ai")) {
                // Check if this is a streaming endpoint (completion requests use SSE)
                const isStreamingEndpoint = parsedRequest.path.includes("/completion");

                if (isStreamingEndpoint) {
                  // Use native TLS for streaming endpoints (CycleTLS doesn't support streaming)
                  console.log("[CONNECTHandler] 🔄 Using native TLS for streaming endpoint");
                  await this.forwardStreamingRequest(parsedRequest, tlsSocket, targetHost);
                } else if (
                  parsedRequest.method === "GET" &&
                  parsedRequest.path.includes("/chat_conversations/") &&
                  parsedRequest.path.includes("tree=True") &&
                  currentConversationId &&
                  this.injectedMessages.has(currentConversationId)
                ) {
                  // SYNC INTERCEPTION: This is a conversation fetch for a conversation with injected messages
                  console.log(
                    `[CONNECTHandler] 🔄 Intercepting conversation sync for ${currentConversationId.slice(0, 8)} (has ${this.injectedMessages.get(currentConversationId)?.length || 0} injected messages)`
                  );
                  await this.forwardWithMessageInjection(parsedRequest, tlsSocket, targetHost, currentConversationId);
                } else if (this.cycleTLSManager) {
                  // Use CycleTLS for non-streaming claude.ai requests to bypass Cloudflare
                  try {
                    await this.forwardViaCycleTLS(parsedRequest, tlsSocket, targetHost);
                  } catch (err) {
                    console.error("[CONNECTHandler] CycleTLS forward failed, trying native TLS:", err);
                    // Fallback to native TLS with modified headers
                    await this.forwardViaNativeTLS(parsedRequest, tlsSocket, targetHost);
                  }
                } else {
                  // CycleTLS not available, use native TLS
                  console.log("[CONNECTHandler] CycleTLS not available, using native TLS");
                  await this.forwardViaNativeTLS(parsedRequest, tlsSocket, targetHost);
                }
              } else if (targetHost.includes("anthropic.com")) {
                // Handle anthropic.com hosts (like a-api.anthropic.com)
                console.log(`[CONNECTHandler] 📡 Anthropic API: ${parsedRequest.method} ${parsedRequest.path}`);
                if (parsedRequest.body.length > 0) {
                  console.log(`[CONNECTHandler] Anthropic API body (${parsedRequest.body.length} bytes): ${parsedRequest.body.toString("utf8").substring(0, 300)}`);
                }
                // Check if this might be a messages/completion endpoint
                if (parsedRequest.path.includes("/messages") || parsedRequest.path.includes("/v1/m")) {
                  console.log(`[CONNECTHandler] 🎯 Potential completion endpoint detected!`);
                }
                const conn = ensureServerConnection();
                conn.write(parsedRequest.raw);
              } else {
                // Use native TLS for other hosts
                const conn = ensureServerConnection();
                conn.write(parsedRequest.raw);
              }
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
      } catch (err) {
        console.error("[CONNECTHandler] Error in tlsSocket 'data' handler:", err);
        if (!tlsSocket.destroyed) {
          tlsSocket.destroy();
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

      // Transform to Anthropic API format (include conversation history for context)
      const anthropicRequest = this.transformToAnthropicFormat(claudeDesktopRequest, targetModel, conversationId);

      // Save transformed request for debugging
      const timestamp = Date.now();
      const filename = `/tmp/transformed_${conversationId?.slice(0, 8) || "unknown"}_${timestamp}.json`;
      fs.writeFileSync(filename, JSON.stringify(anthropicRequest, null, 2));
      console.log(`[CONNECTHandler] Saved transformed request to ${filename}`);

      // Call provider API
      const response = await this.callProviderAPI(targetModel, anthropicRequest);

      // Transform and stream response back to client, passing conversation ID for sync support
      await this.streamTransformedResponse(tlsSocket, response, targetModel, claudeDesktopRequest, conversationId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[CONNECTHandler] Interception failed:", errorMsg);

      // Log error
      const logFilename = `/tmp/fallback_${Date.now()}.json`;
      fs.writeFileSync(
        logFilename,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            targetModel,
            error: errorMsg,
            conversationId,
          },
          null,
          2
        )
      );

      // Show error in UI instead of falling back to Claude
      this.streamErrorAsResponse(tlsSocket, targetModel, errorMsg);
    }
  }

  /**
   * Stream an error message as a Claude-compatible response so it shows in the UI
   */
  private streamErrorAsResponse(
    tlsSocket: tls.TLSSocket,
    targetModel: string,
    errorMsg: string
  ): void {
    // Write HTTP response headers
    tlsSocket.write(
      "HTTP/1.1 200 OK\r\n" +
        "Content-Type: text/event-stream; charset=utf-8\r\n" +
        "Cache-Control: no-cache\r\n" +
        "Connection: keep-alive\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        `request-id: req_error_${Date.now().toString(36)}\r\n` +
        "\r\n"
    );

    const msgId = `error_${Date.now().toString(36)}`;
    const msgUuid = crypto.randomUUID();
    const traceId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");

    // Helper to write SSE event
    const writeEvent = (event: string, data: unknown) => {
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const chunkSize = Buffer.byteLength(chunk, "utf8").toString(16);
      tlsSocket.write(`${chunkSize}\r\n${chunk}\r\n`);
    };

    // Format error message for display
    const errorText = `⚠️ **Claudish Proxy Error**\n\n` +
      `Failed to route request to **${targetModel}**:\n\n` +
      `\`\`\`\n${errorMsg}\n\`\`\`\n\n` +
      `_Check your API key and model configuration in ClaudishProxy settings._`;

    // Send message_start
    writeEvent("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: "",
        uuid: msgUuid,
        content: [],
        stop_reason: null,
        trace_id: traceId,
      },
    });

    // Send ping
    writeEvent("ping", { type: "ping" });

    // Send content block start
    writeEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
        citations: [],
        start_timestamp: new Date().toISOString(),
      },
    });

    // Send error text as delta
    writeEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: errorText, citations: [] },
    });

    // Send content block stop
    writeEvent("content_block_stop", { type: "content_block_stop", index: 0 });

    // Send message_delta
    writeEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
    });

    // Send message_limit
    writeEvent("message_limit", {
      type: "message_limit",
      message_limit: { type: "within_limit" },
    });

    // Send message_stop
    writeEvent("message_stop", { type: "message_stop" });

    // End chunked transfer
    tlsSocket.write("0\r\n\r\n");

    console.log(`[CONNECTHandler] Streamed error response to UI: ${errorMsg.slice(0, 100)}`);
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
    let actualModel = targetModel;

    // Native OpenAI API (oai/ prefix)
    if (targetModel.startsWith("oai/")) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = this.apiKeys.openai;
      actualModel = targetModel.slice(4); // Remove "oai/" prefix
      if (!apiKey) {
        throw new Error("OpenAI API key not configured");
      }
      headers = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      console.log(`[CONNECTHandler] Using native OpenAI API with model: ${actualModel}`);
    }
    // OpenRouter (default for other models with /)
    else if (targetModel.includes("/")) {
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

    // Build payload - OpenAI uses max_completion_tokens for newer models
    const isNativeOpenAI = targetModel.startsWith("oai/");
    const openaiPayload: Record<string, unknown> = {
      model: actualModel,
      messages: req.messages,
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

    // Use max_completion_tokens for native OpenAI, max_tokens for OpenRouter
    if (isNativeOpenAI) {
      openaiPayload.max_completion_tokens = req.max_tokens;
    } else {
      openaiPayload.max_tokens = req.max_tokens;
    }

    console.log(`[CONNECTHandler] Calling ${apiUrl} with model ${actualModel}`);

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
    targetModel: string,
    originalRequest?: { parent_message_uuid?: string; prompt?: string },
    conversationId?: string
  ): Promise<void> {
    // Write HTTP response headers
    tlsSocket.write(
      "HTTP/1.1 200 OK\r\n" +
        "Content-Type: text/event-stream; charset=utf-8\r\n" +
        "Cache-Control: no-cache\r\n" +
        "Connection: keep-alive\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        `request-id: req_${Date.now().toString(36)}\r\n` +
        "\r\n"
    );

    const decoder = new TextDecoder();

    // Generate IDs matching Claude's format
    const msgId = `chatcompl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const msgUuid = crypto.randomUUID();
    // Generate trace ID without using crypto.randomBytes (not available in Bun)
    const traceId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
    const requestId = `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const parentUuid = originalRequest?.parent_message_uuid || crypto.randomUUID();

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

    // Track full response for sync support
    let fullResponseText = "";
    const responseStartTime = new Date().toISOString();

    // Generate UUIDs for message storage
    const userMsgUuid = crypto.randomUUID();

    // Helper to write SSE event
    const writeEvent = (event: string, data: unknown) => {
      const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const chunkSize = Buffer.byteLength(chunk, "utf8").toString(16);
      tlsSocket.write(`${chunkSize}\r\n${chunk}\r\n`);
    };

    // Send message_start with Claude Desktop-compatible format
    writeEvent("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: "", // Claude Desktop expects empty string for model in response
        parent_uuid: parentUuid,
        uuid: msgUuid,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        trace_id: traceId,
        request_id: requestId,
      },
    });

    // Send ping event (required by Claude Desktop)
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
                  content_block: {
                    type: "text",
                    text: "",
                    citations: [],
                    start_timestamp: new Date().toISOString(),
                    stop_timestamp: null,
                    flags: null,
                  },
                });
                textStarted = true;
              }
              writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: textIdx,
                delta: { type: "text_delta", text: txt, citations: [] },
              });

              // Track full response for sync support
              fullResponseText += txt;
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

      // Send final events (matching Claude Desktop's exact format)
      writeEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
      });

      // Send message_limit event (Claude Desktop expects this)
      writeEvent("message_limit", {
        type: "message_limit",
        message_limit: {
          type: "within_limit",
          resetsAt: Math.floor(Date.now() / 1000) + 86400,
          remaining: 100,
          perModelLimit: false,
          representativeClaim: "seven_day",
          overageDisabledReason: null,
          overageInUse: false,
        },
      });

      writeEvent("message_stop", { type: "message_stop" });

      // End chunked transfer encoding
      tlsSocket.write("0\r\n\r\n");

      // Store messages for sync support (so conversation GET requests return our injected messages)
      console.log(`[CONNECTHandler] 📊 Storage check: convId=${!!conversationId}, prompt=${!!originalRequest?.prompt}, responseLen=${fullResponseText.length}`);
      if (conversationId && originalRequest?.prompt && fullResponseText) {
        const now = new Date().toISOString();
        const responseEndTime = now;

        // Get existing messages or start fresh
        const existingMessages = this.injectedMessages.get(conversationId) || [];

        // Calculate next index
        const nextIndex = existingMessages.length;

        // For parent chain: if we have previous messages, use the last assistant's UUID
        // Otherwise use the parentUuid from the request (root UUID for first message)
        const prevAssistantMsg = existingMessages.length > 0
          ? existingMessages[existingMessages.length - 1]
          : null;
        const actualParentUuid = prevAssistantMsg?.sender === "assistant"
          ? prevAssistantMsg.uuid
          : parentUuid;

        // Create user message
        const userMessage = {
          uuid: userMsgUuid,
          text: "",
          content: [
            {
              start_timestamp: responseStartTime,
              stop_timestamp: responseStartTime,
              type: "text",
              text: originalRequest.prompt,
              citations: [] as unknown[],
            },
          ],
          sender: "human" as const,
          index: nextIndex,
          created_at: responseStartTime,
          updated_at: responseStartTime,
          truncated: false,
          attachments: [] as unknown[],
          files: [] as unknown[],
          files_v2: [] as unknown[],
          sync_sources: [] as unknown[],
          parent_message_uuid: actualParentUuid,
        };

        // Create assistant message
        const assistantMessage = {
          uuid: msgUuid,
          text: "",
          content: [
            {
              start_timestamp: responseStartTime,
              stop_timestamp: responseEndTime,
              type: "text",
              text: fullResponseText,
              citations: [] as unknown[],
            },
          ],
          sender: "assistant" as const,
          index: nextIndex + 1,
          created_at: responseStartTime,
          updated_at: responseEndTime,
          truncated: false,
          attachments: [] as unknown[],
          files: [] as unknown[],
          files_v2: [] as unknown[],
          sync_sources: [] as unknown[],
          parent_message_uuid: userMsgUuid,
        };

        // Store both messages
        existingMessages.push(userMessage, assistantMessage);
        this.injectedMessages.set(conversationId, existingMessages);

        console.log(
          `[CONNECTHandler] 📝 Stored ${existingMessages.length} messages for conversation ${conversationId.slice(0, 8)}`
        );

        // Debug: Save injected message sample for comparison
        try {
          const fs = require('fs');
          fs.writeFileSync('/tmp/injected_message_sample.json', JSON.stringify(assistantMessage, null, 2));
          console.log(`[CONNECTHandler] 🔍 Injected message sample saved to /tmp/injected_message_sample.json`);
        } catch (e) { /* ignore */ }
      }

      console.log(
        `[CONNECTHandler] ✅ Interception complete. Tokens: in=${usage?.prompt_tokens || 0}, out=${usage?.completion_tokens || 0}`
      );

      // Write success log for debugging
      const successFilename = `/tmp/success_${conversationId?.slice(0, 8) || "unknown"}_${Date.now()}.json`;
      fs.writeFileSync(
        successFilename,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          targetModel,
          conversationId,
          responseLength: fullResponseText.length,
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          responsePreview: fullResponseText.slice(0, 200),
        }, null, 2)
      );
      console.log(`[CONNECTHandler] 📝 Success logged to ${successFilename}`);
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
