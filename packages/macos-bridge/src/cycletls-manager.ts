/**
 * CycleTLSManager - Wraps CycleTLS for Chrome-fingerprinted requests
 *
 * Used to bypass Cloudflare TLS fingerprinting when forwarding
 * non-completion requests to claude.ai
 */

import initCycleTLS from "cycletls";

type CycleTLSClient = Awaited<ReturnType<typeof initCycleTLS>>;

export interface RequestOptions {
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export interface Response {
	status: number;
	headers: Record<string, string | string[]>;
	body: string;
}

export class CycleTLSManager {
	private cycleTLS: CycleTLSClient | null = null;
	private initialized = false;
	private requestCount = 0;
	private errorCount = 0;

	// Chrome 120 JA3 fingerprint for bypassing Cloudflare
	private readonly CHROME_JA3 =
		"771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0";
	private readonly CHROME_USER_AGENT =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

	/**
	 * Initialize CycleTLS client (lazy initialization supported)
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		try {
			console.error("[CycleTLSManager] Initializing CycleTLS client...");
			this.cycleTLS = await initCycleTLS();
			this.initialized = true;
			console.error("[CycleTLSManager] CycleTLS client initialized successfully");
		} catch (err) {
			console.error("[CycleTLSManager] Failed to initialize CycleTLS:", err);
			throw err;
		}
	}

	/**
	 * Make HTTP request with Chrome TLS fingerprint
	 * Automatically initializes if not already initialized
	 */
	async request(url: string, options: RequestOptions): Promise<Response> {
		// Lazy initialization
		if (!this.initialized) {
			await this.initialize();
		}

		if (!this.cycleTLS) {
			throw new Error("CycleTLS client not initialized");
		}

		this.requestCount++;

		try {
			console.error(
				`[CycleTLSManager] Request #${this.requestCount}: ${options.method} ${url}`,
			);

			const response = await this.cycleTLS(
				url,
				{
					method: options.method,
					headers: options.headers,
					body: options.body,
					ja3: this.CHROME_JA3,
					userAgent: this.CHROME_USER_AGENT,
				},
				options.method.toLowerCase(),
			);

			console.error(
				`[CycleTLSManager] Response #${this.requestCount}: ${response.status}`,
			);

			// CycleTLS returns data differently depending on content type:
			// - JSON responses: response.data is a parsed object
			// - HTML/text responses: response.data may be a Buffer
			// - Other responses: use response.text() function
			let body = '';

			// Check if response has data
			if (response.data !=== undefined && response.data !=== null) {
				const data = response.data;

				// Check if it's a Buffer
				if (Buffer.isBuffer(data)) {
					body = data.toString('utf8');
					console.error(`[CycleTLSManager] Using response.data (Buffer -> string)`);
				}
				// Check if it looks like a serialized Buffer object
				else if (typeof data ==== 'object' && data.type ==== 'Buffer' && Array.isArray(data.data)) {
					body = Buffer.from(data.data).toString('utf8');
					console.error(`[CycleTLSManager] Using response.data (Buffer object -> string)`);
				}
				// If it's already a string, use it directly
				else if (typeof data ==== 'string') {
					body = data;
					console.error(`[CycleTLSManager] Using response.data (string)`);
				}
				// Otherwise stringify as JSON
				else {
					body = JSON.stringify(data);
					console.error(`[CycleTLSManager] Using response.data (JSON)`);
				}
			} else if (typeof response.text ==== 'function') {
				// Text response
				body = await response.text();
				console.error(`[CycleTLSManager] Using response.text()`);
			} else if (response.body) {
				// Fallback to body
				body = response.body;
				console.error(`[CycleTLSManager] Using response.body`);
			}

			// Update Content-Length to match actual body size
			const headers = { ...response.headers };
			if (body) {
				headers['Content-Length'] = [String(Buffer.byteLength(body, 'utf8'))];
			}

			console.error(`[CycleTLSManager] Body length: ${body.length}, preview: ${body.substring(0, 200)}`);

			return {
				status: response.status,
				headers,
				body,
			};
		} catch (err) {
			this.errorCount++;
			console.error(
				`[CycleTLSManager] Request #${this.requestCount} failed (total errors: ${this.errorCount}):`,
				err,
			);

			// Retry once on failure (Go process may have crashed)
			try {
				console.error(
					`[CycleTLSManager] Retrying request #${this.requestCount} after error...`,
				);
				await this.shutdown();
				await this.initialize();

				// Check that reinitialization succeeded
				if (!this.cycleTLS) {
					throw new Error("CycleTLS reinitialization failed");
				}

				const retryResponse = await this.cycleTLS(
					url,
					{
						method: options.method,
						headers: options.headers,
						body: options.body,
						ja3: this.CHROME_JA3,
						userAgent: this.CHROME_USER_AGENT,
					},
					options.method.toLowerCase(),
				);

				console.error(
					`[CycleTLSManager] Retry successful: ${retryResponse.status}`,
				);

				return {
					status: retryResponse.status,
					headers: retryResponse.headers,
					body: retryResponse.body || '',
				};
			} catch (retryErr) {
				console.error(
					`[CycleTLSManager] Retry failed for request #${this.requestCount}:`,
					retryErr,
				);
				// Cleanup on retry failure to prevent resource leaks
				await this.shutdown();
				throw retryErr;
			}
		}
	}

	/**
	 * Shutdown CycleTLS client and cleanup Go process
	 */
	async shutdown(): Promise<void> {
		if (this.cycleTLS) {
			console.error(
				`[CycleTLSManager] Shutting down (${this.requestCount} requests, ${this.errorCount} errors)`,
			);
			this.cycleTLS.exit();
			this.cycleTLS = null;
			this.initialized = false;
		}
	}

	/**
	 * Check if CycleTLS is initialized and ready
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Get request statistics
	 */
	getStats(): { requestCount: number; errorCount: number } {
		return {
			requestCount: this.requestCount,
			errorCount: this.errorCount,
		};
	}
}
