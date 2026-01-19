import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import tls, { type SecureContext } from "node:tls";
import type { CertificateManager } from "./certificate-manager";

// Maximum SecureContext cache size to prevent memory exhaustion
const MAX_CONTEXT_CACHE_SIZE = 100;

export interface HTTPSProxyServerOptions {
  port?: number;
  hostname?: string;
}

export class HTTPSProxyServer {
  private server: https.Server | null = null;
  private port = 0;
  private hostname = "127.0.0.1";
  private certManager: CertificateManager;
  private requestHandler: (req: IncomingMessage, res: ServerResponse) => void;
  private secureContextCache: Map<string, SecureContext> = new Map();

  constructor(
    certManager: CertificateManager,
    requestHandler: (req: IncomingMessage, res: ServerResponse) => void
  ) {
    this.certManager = certManager;
    this.requestHandler = requestHandler;
  }

  /**
   * Start HTTPS server with SNI callback
   * @param port Optional port number (0 for auto-assignment)
   * @returns The actual port the server is listening on
   */
  async start(port = 0): Promise<number> {
    if (this.server) {
      throw new Error("SERVER_START_ERROR: Server is already running");
    }

    try {
      // Create HTTPS server with SNI callback
      this.server = https.createServer(
        {
          SNICallback: (servername, cb) => this.handleSNI(servername, cb),
        },
        (req, res) => this.requestHandler(req, res)
      );

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(port, this.hostname, () => {
          const address = this.server!.address();
          if (address && typeof address === "object") {
            this.port = address.port;
          }
          console.log(`[HTTPSProxyServer] Started on ${this.hostname}:${this.port}`);
          resolve();
        });

        this.server!.on("error", (err) => {
          console.error("[HTTPSProxyServer] SERVER_START_ERROR:", err);
          reject(err);
        });
      });

      // Log TLS handshake completion
      this.server.on("secureConnection", (tlsSocket) => {
        const servername = tlsSocket.servername || "unknown";
        console.log(`[HTTPSProxyServer] TLS handshake completed for ${servername}`);
      });

      return this.port;
    } catch (err) {
      this.server = null;
      throw new Error(`SERVER_START_ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Stop the HTTPS server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          console.error("[HTTPSProxyServer] Error stopping server:", err);
          reject(err);
        } else {
          console.log("[HTTPSProxyServer] Server stopped");
          this.server = null;
          this.port = 0;
          this.secureContextCache.clear();
          resolve();
        }
      });
    });
  }

  /**
   * Get the port the server is listening on
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the underlying Node.js HTTPS server
   */
  getServer(): https.Server | null {
    return this.server;
  }

  /**
   * Handle SNI callback for dynamic certificate serving
   */
  private async handleSNI(
    servername: string,
    cb: (err: Error | null, ctx?: SecureContext) => void
  ): Promise<void> {
    try {
      console.log(`[HTTPSProxyServer] SNI request for ${servername}`);

      // Check cache first
      const cachedContext = this.secureContextCache.get(servername);
      if (cachedContext) {
        cb(null, cachedContext);
        return;
      }

      // Get certificate from CertificateManager
      const { cert, key } = await this.certManager.getCertForDomain(servername);

      // Create secure context
      const ctx = tls.createSecureContext({
        cert,
        key,
      });

      // Cache for future requests (with size limit)
      if (this.secureContextCache.size >= MAX_CONTEXT_CACHE_SIZE) {
        const oldestKey = this.secureContextCache.keys().next().value;
        if (oldestKey) {
          this.secureContextCache.delete(oldestKey);
        }
      }
      this.secureContextCache.set(servername, ctx);

      cb(null, ctx);
    } catch (err) {
      console.error(`[HTTPSProxyServer] SNI_CALLBACK_ERROR for ${servername}:`, err);
      cb(err as Error);
    }
  }
}
