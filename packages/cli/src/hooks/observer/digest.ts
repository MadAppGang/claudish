/**
 * Observer input construction.
 *
 * The observer never sees the conversation. It sees a DIGEST: which tools are on
 * offer, what the harness looks like, and the shape of the call the model just
 * proposed. Two reasons, both load-bearing:
 *
 *  - Latency. The observer runs beside a live request. Feeding it 180K tokens of
 *    context would cost more than the request it is advising on.
 *  - Privacy. A digest carries no message text, so enabling a local advisory
 *    model never widens what the user's conversation is exposed to.
 *
 * Argument VALUES are omitted except for path-like fields, which are the subject
 * of the checks themselves and stay on the machine (the observer is a local
 * model). Everything else is reduced to key names.
 */

import type { HarnessFacts } from "../public.js";

export interface ObserverDigest {
  model: string;
  /** Tool names on offer, capped — the tail is MCP tools and rarely relevant. */
  toolNames: string[];
  harness: HarnessFacts;
  proposedCall?: {
    name: string;
    /** Argument keys only. */
    argKeys: string[];
    /** Path-like argument values, which are what the path rules reason about. */
    paths?: string[];
  };
  /** The only rule ids the observer is permitted to return. */
  ruleVocabulary: string[];
}

const MAX_TOOL_NAMES = 40;
const PATH_KEYS = new Set(["file_path", "path", "notebook_path", "filePath"]);

export function buildDigest(params: {
  model: string;
  toolNames: string[];
  harness: HarnessFacts;
  ruleVocabulary: string[];
  call?: { name: string; args: Record<string, any> };
}): ObserverDigest {
  const digest: ObserverDigest = {
    model: params.model,
    toolNames: params.toolNames.slice(0, MAX_TOOL_NAMES),
    harness: params.harness,
    ruleVocabulary: params.ruleVocabulary,
  };

  if (params.call) {
    const paths: string[] = [];
    for (const [key, value] of Object.entries(params.call.args)) {
      if (PATH_KEYS.has(key) && typeof value === "string") paths.push(value);
    }
    digest.proposedCall = {
      name: params.call.name,
      argKeys: Object.keys(params.call.args),
      paths: paths.length > 0 ? paths : undefined,
    };
  }

  return digest;
}
