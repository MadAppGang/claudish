// Sits between Context Gateway and api.anthropic.com for the gateway's own
// Haiku calls. Forwards each call unchanged and appends one JSON line per
// answer: the requested model, the model that answered, the HTTP status and
// the usage block. It never writes a header or a body.
//
// Only calls signed with x-api-key are forwarded. A call signed with a Bearer
// token would be Claude Code's login, which this variant must not use for
// Haiku; it is refused with 403 and recorded as auth "bearer".
//
// usage: bun usage-recorder.ts <port> <log file>

import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? "18434");
const logFile = process.argv[3] ?? "logs/haiku_calls.jsonl";
const upstream = "https://api.anthropic.com";
const forwarded = ["content-type", "x-api-key", "anthropic-version", "anthropic-beta"];

function record(entry: Record<string, unknown>): void {
  appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");

    const path = url.pathname.replace(/^\/anthropic/, "");
    const body = await req.arrayBuffer();
    let requestModel: unknown;
    try {
      requestModel = JSON.parse(new TextDecoder().decode(body)).model;
    } catch {
      requestModel = undefined;
    }

    if (!req.headers.get("x-api-key")) {
      const auth = req.headers.get("authorization") ? "bearer" : "none";
      record({ path, request_model: requestModel, status: 403, auth, refused: true });
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "permission_error",
            message: "usage recorder forwards x-api-key calls only",
          },
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        }
      );
    }

    const headers = new Headers();
    for (const name of forwarded) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(upstream + path + url.search, { method: req.method, headers, body });
    } catch (err) {
      record({
        path,
        request_model: requestModel,
        status: 0,
        auth: "x-api-key",
        network_error: String(err).slice(0, 200),
      });
      return new Response("upstream unreachable", { status: 502 });
    }
    const text = await res.text();
    let parsed: { model?: unknown; usage?: unknown; error?: { type?: unknown } } | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    record({
      path,
      request_model: requestModel,
      status: res.status,
      auth: "x-api-key",
      model: parsed?.model,
      usage: parsed?.usage,
      error_type: parsed?.error?.type,
      ms: Date.now() - started,
    });
    return new Response(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  },
});
