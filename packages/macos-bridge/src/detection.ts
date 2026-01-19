/**
 * User-Agent Detection Module
 *
 * Detects client applications from their User-Agent strings with confidence scoring.
 * Also supports origin-based detection for additional confidence.
 */

import type { UserAgentDetection } from "./types.js";

/**
 * Known application patterns with detection logic
 */
interface AppPattern {
  name: string;
  patterns: RegExp[];
  versionPattern?: RegExp;
  /** Origin header values that indicate this app */
  origins?: string[];
}

const KNOWN_APPS: AppPattern[] = [
  {
    // Claude Desktop: "Claude/1.0.3218" in Electron UA
    // Origin: https://claude.ai
    // Host: a-api.anthropic.com
    name: "Claude Desktop",
    patterns: [/Claude\/[\d.]+/i, /Electron\/[\d.]+.*Claude/i],
    versionPattern: /Claude\/([\d.]+)/i,
    origins: ["https://claude.ai"],
  },
  {
    // Cursor IDE: "Cursor/0.40" pattern
    name: "Cursor",
    patterns: [/Cursor\/[\d.]+/i],
    versionPattern: /Cursor\/([\d.]+)/i,
  },
  {
    // VS Code with Cline/Continue extensions
    name: "VS Code",
    patterns: [/Code\/[\d.]+/i, /VSCode\/[\d.]+/i],
    versionPattern: /Code\/([\d.]+)/i,
  },
  {
    // Zed editor
    name: "Zed",
    patterns: [/Zed\/[\d.]+/i],
    versionPattern: /Zed\/([\d.]+)/i,
  },
  {
    // Generic Electron apps
    name: "Electron App",
    patterns: [/Electron\/[\d.]+/i],
    versionPattern: /Electron\/([\d.]+)/i,
  },
  {
    // Python SDK (anthropic package)
    name: "Anthropic Python SDK",
    patterns: [/anthropic-python\/[\d.]+/i, /python-requests/i],
    versionPattern: /anthropic-python\/([\d.]+)/i,
  },
  {
    // Node.js SDK
    name: "Anthropic Node SDK",
    patterns: [/anthropic-typescript\/[\d.]+/i, /node-fetch/i],
    versionPattern: /anthropic-typescript\/([\d.]+)/i,
  },
  {
    // curl
    name: "curl",
    patterns: [/^curl\//i],
    versionPattern: /curl\/([\d.]+)/i,
  },
];

/**
 * Extract platform from User-Agent
 */
function extractPlatform(userAgent: string): string | undefined {
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS")) {
    return "macOS";
  }
  if (userAgent.includes("Windows")) {
    return "Windows";
  }
  if (userAgent.includes("Linux")) {
    return "Linux";
  }
  return undefined;
}

/**
 * Detect application from User-Agent string
 *
 * @param userAgent - The User-Agent header value
 * @returns Detection result with name, confidence, and optional version
 */
export function detectUserAgent(userAgent: string): UserAgentDetection {
  if (!userAgent) {
    return {
      name: "Unknown",
      confidence: 0,
    };
  }

  // Try each known app pattern
  for (const app of KNOWN_APPS) {
    for (const pattern of app.patterns) {
      if (pattern.test(userAgent)) {
        // Extract version if pattern is available
        let version: string | undefined;
        if (app.versionPattern) {
          const versionMatch = userAgent.match(app.versionPattern);
          if (versionMatch) {
            version = versionMatch[1];
          }
        }

        // Calculate confidence based on pattern specificity
        // More specific patterns (like "Claude/x.x.x") get higher confidence
        let confidence = 0.8;

        // Claude Desktop has very specific UA, boost confidence
        if (app.name === "Claude Desktop" && userAgent.includes("Claude/")) {
          confidence = 0.95;
        }

        // Generic Electron gets lower confidence
        if (app.name === "Electron App") {
          confidence = 0.5;
        }

        return {
          name: app.name,
          confidence,
          version,
          platform: extractPlatform(userAgent),
        };
      }
    }
  }

  // Unknown application - try to extract any useful info
  const platform = extractPlatform(userAgent);

  // Check for common HTTP libraries
  if (userAgent.includes("axios") || userAgent.includes("node-fetch")) {
    return {
      name: "HTTP Client",
      confidence: 0.4,
      platform,
    };
  }

  // Default to unknown with low confidence
  return {
    name: "Unknown",
    confidence: 0.1,
    platform,
  };
}

/**
 * Check if User-Agent indicates Claude Desktop specifically
 */
export function isClaudeDesktop(userAgent: string): boolean {
  return /Claude\/[\d.]+/i.test(userAgent);
}

/**
 * Extract Claude Desktop version from User-Agent
 */
export function getClaudeDesktopVersion(userAgent: string): string | undefined {
  const match = userAgent.match(/Claude\/([\d.]+)/i);
  return match ? match[1] : undefined;
}

/**
 * Request headers for enhanced detection
 */
export interface RequestHeaders {
  userAgent?: string;
  origin?: string;
  host?: string;
  referer?: string;
}

/**
 * Enhanced detection using multiple signals (User-Agent, Origin, Host)
 * Provides higher confidence by combining multiple identification signals.
 *
 * @param headers - Request headers for detection
 * @returns Detection result with enhanced confidence
 */
export function detectFromHeaders(headers: RequestHeaders): UserAgentDetection {
  const { userAgent = "", origin, host } = headers;

  // Start with User-Agent detection
  const baseDetection = detectUserAgent(userAgent);

  // Enhance confidence for Claude Desktop if additional signals match
  if (baseDetection.name === "Claude Desktop") {
    let confidenceBoost = 0;

    // Origin header matches claude.ai
    if (origin === "https://claude.ai") {
      confidenceBoost += 0.03;
    }

    // Host is a-api.anthropic.com (Claude Desktop specific)
    if (host === "a-api.anthropic.com") {
      confidenceBoost += 0.02;
    }

    return {
      ...baseDetection,
      confidence: Math.min(1.0, baseDetection.confidence + confidenceBoost),
    };
  }

  // Check for Claude Desktop based on origin + host even if UA doesn't match
  // This catches cases where User-Agent might be modified
  if (origin === "https://claude.ai" && host === "a-api.anthropic.com") {
    // Strong signal for Claude Desktop even without matching UA
    if (baseDetection.name === "Unknown" || baseDetection.name === "Electron App") {
      return {
        name: "Claude Desktop",
        confidence: 0.85,
        platform: extractPlatform(userAgent),
      };
    }
  }

  return baseDetection;
}
