/**
 * Request logger (fork extension).
 *
 * Logs remote IP + request metadata for cluster traffic analysis.
 * Resolves source IP from x-forwarded-for, x-real-ip, or direct connection map.
 *
 * Leak investigation mode: dumps system prompt excerpt + first + last user message.
 */

import { mkdirSync } from "fs";
import { writeFile } from "fs/promises";

// Capture writes are FIRE-AND-FORGET on purpose. The old writeFileSync stalled the
// ENTIRE event loop on every request (Bun is single-threaded) — over a Docker
// bind-mount to a Windows dir, one slow write froze every handler, including the
// 4s /health heartbeat, while longer streams rode through unnoticed (incident
// 2026-08-20: PROCESS HUNG episodes diagnosed with po-2023, greenlit fix).
// Async writes can land out of request order; the monotonic counter + ISO timestamp
// in the filename is what the traffic-*.ps1 scripts reassemble by.
let captureDirReady: string | null = null;
let capN = 0;

function ensureCaptureDir(dir: string): boolean {
  if (captureDirReady === dir) return true;
  try {
    mkdirSync(dir, { recursive: true }); // no-op on an existing dir, never throws EEXIST
    captureDirReady = dir;
    return true;
  } catch (e) {
    process.stdout.write(`  [capture] mkdir error: ${String(e)}\n`);
    return false;
  }
}

export function resolveSourceIp(
  req: Request,
  remoteAddrMap: WeakMap<Request, string>
): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const xrip = req.headers.get("x-real-ip") || "";
  const directIp = remoteAddrMap.get(req) || "";
  return xff || xrip || directIp || "direct";
}

function excerpt(s: string, maxLen = 200): string {
  const flat = s.replace(/\n/g, "\\n").replace(/\r/g, "");
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen) + "...";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => b.text as string);
    return texts.join(" ");
  }
  return "";
}

export function logRequest(
  body: Record<string, unknown>,
  handlerName: string,
  req: Request,
  remoteAddrMap: WeakMap<Request, string>
): void {
  const src = resolveSourceIp(req, remoteAddrMap);
  const ua = req.headers.get("user-agent") || "";
  const model = (body.model as string) ?? "(none)";
  // Cluster attribution header (set by each Claude Code via ANTHROPIC_CUSTOM_HEADERS).
  // Read once here so it lands in BOTH the captured JSON body and the stdout tag —
  // the capture side is what the traffic-*.ps1 analysis scripts attribute by.
  const machine = req.headers.get("x-claudish-machine") || "";

  // Full-body capture (temporary diagnostic — gated by CLAUDISH_CAPTURE_DIR env).
  // Disabled when the env var is unset, so this is a no-op in normal operation.
  const captureDir = process.env.CLAUDISH_CAPTURE_DIR;
  if (captureDir && ensureCaptureDir(captureDir)) {
    const n = ++capN;
    // Shared handoff for response-capture's resp-*.sse correlation (reqN= in its
    // header). Module-local alone leaves it reading 0 — every resp file became
    // r0000 after the async rewrite dropped this (pairing broke fleet-wide).
    (globalThis as Record<string, unknown>).__capN = n;
    const safeSrc = src.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `${captureDir}/req-${process.pid}-${String(n).padStart(4, "0")}-${ts}-${safeSrc}.json`;
    const payload = JSON.stringify({ ts, src, machine, model, pid: process.pid, body });
    // Never block the request path: fire-and-forget with a silent catch.
    writeFile(file, payload).catch((e) => {
      process.stdout.write(`  [capture] error: ${String(e)}\n`);
    });
  }

  // Header line
  const msgs = Array.isArray(body.messages) ? body.messages.length : 0;
  const stream = body.stream === true ? "stream" : "sync";
  const maxTokens = body.max_tokens ?? "-";
  const machineTag = machine ? ` machine=${machine}` : "";
  process.stdout.write(
    `[claudish] [Request] model=${model} handler=${handlerName} src=${src} ${stream} msgs=${msgs} max_tokens=${maxTokens}${machineTag} ua=${ua.slice(0, 80)}\n`
  );

  // System prompt excerpt (first 300 chars)
  const sysText = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system)
      ? JSON.stringify(body.system)
      : "";
  if (sysText) {
    process.stdout.write(`  [system] ${excerpt(sysText, 300)}\n`);
  }

  // First user message excerpt
  const messages = (body.messages as Record<string, unknown>[]) ?? [];
  if (messages.length > 0) {
    const first = extractText(messages[0].content);
    if (first) {
      process.stdout.write(`  [msg:0] ${excerpt(first, 200)}\n`);
    }
  }

  // Last user message excerpt
  if (messages.length > 1) {
    const last = extractText(messages[messages.length - 1].content);
    if (last) {
      process.stdout.write(`  [msg:${messages.length - 1}] ${excerpt(last, 300)}\n`);
    }
  }
}
