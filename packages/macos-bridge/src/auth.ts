/**
 * Authentication Module
 *
 * Provides token-based authentication for the bridge HTTP API.
 * Uses cryptographically secure random tokens.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Context, Next } from 'hono';

/**
 * Authentication manager for bridge security
 */
export class AuthManager {
	private token: string;
	private tokenHash: string;

	constructor() {
		this.token = this.generateToken();
		this.tokenHash = this.hashToken(this.token);
	}

	/**
	 * Generate cryptographically secure random token
	 * 32 bytes = 256 bits of entropy, output as 64 character hex string
	 */
	private generateToken(): string {
		return randomBytes(32).toString('hex');
	}

	/**
	 * Hash token for comparison (defense in depth)
	 * Even if memory is compromised, the original token is protected
	 */
	private hashToken(token: string): string {
		return createHash('sha256').update(token).digest('hex');
	}

	/**
	 * Get token for sharing with Swift app
	 * This token is output to stdout at startup for the Swift app to parse
	 */
	getToken(): string {
		return this.token;
	}

	/**
	 * Validate a provided token
	 */
	validateToken(providedToken: string): boolean {
		const providedHash = this.hashToken(providedToken);
		return providedHash === this.tokenHash;
	}

	/**
	 * Hono middleware for authentication
	 *
	 * Public endpoints: /health
	 * Protected endpoints: All others require Bearer token
	 */
	middleware() {
		return async (c: Context, next: Next) => {
			const path = c.req.path;

			// Public endpoints (no auth required)
			// - /health: Swift app checks if bridge is running
			// - /proxy.pac: Browsers need to fetch PAC file without auth
			if (path === '/health' || path === '/proxy.pac') {
				return next();
			}

			// All other endpoints require authentication
			const authHeader = c.req.header('Authorization');
			if (!authHeader || !authHeader.startsWith('Bearer ')) {
				return c.json({ error: 'Unauthorized - Bearer token required' }, 401);
			}

			const providedToken = authHeader.substring(7); // Remove "Bearer "

			if (!this.validateToken(providedToken)) {
				return c.json({ error: 'Unauthorized - Invalid token' }, 401);
			}

			// Token valid, proceed
			return next();
		};
	}

	/**
	 * Get masked token for logging (shows first 8 and last 4 chars)
	 */
	getMaskedToken(): string {
		return `${this.token.substring(0, 8)}...${this.token.substring(this.token.length - 4)}`;
	}
}
