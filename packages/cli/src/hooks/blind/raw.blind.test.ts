import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stubEvents } from "../../test-helpers/stub-upstream.ts";
import {
  events,
  type ProxyFixture,
  gatedProvider,
  readUntil,
  startProxy,
  textOf,
  thinkingOf,
  until,
  userRows,
  waitJournal,
} from "./support.ts";

const fixtures: ProxyFixture[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const f of fixtures.splice(0)) await f.close();
});
const imports =
  'import {writeFileSync,appendFileSync} from "node:fs";import {join} from "node:path";';
const rawHook = (raw: string, fields = "") =>
  `export default {apiVersion:1,id:"test",unsafe:true,${fields}raw:{${raw}}};`;

async function fixture(code: string, opts: Partial<Parameters<typeof startProxy>[0]> = {}) {
  const f = await startProxy({ ...opts, modules: [{ name: "sample.ts", code }] });
  fixtures.push(f);
  return f;
}
function userMessage(f: ProxyFixture) {
  const body = f.stub.requests[0]!.body as { messages: Array<{ role: string; content: unknown }> };
  return body.messages.filter((m) => m.role === "user");
}

function replayProvider(deltas: Array<{ delta: Record<string, unknown>; finish?: string }>) {
  const frames = deltas.map(
    (e) =>
      `data: ${JSON.stringify({ id: "chatcmpl-raw", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta: e.delta, finish_reason: e.finish ?? null }] })}\n\n`
  );
  frames.push("data: [DONE]\n\n");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.method !== "POST") return Response.json({ data: [] });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const frame of frames) c.enqueue(new TextEncoder().encode(frame));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
function withoutPings(raw: string): string {
  return raw
    .split(/\r?\n\r?\n/)
    .slice(0, -1)
    .filter((frame) => {
      // REQ RAW-4 / X-6 / X-7: the stream may end with the OpenAI-style `data: [DONE]` terminator,
      // which is not JSON; keep it as an ordinary frame.
      const data = frame
        .split(/\r?\n/)
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      return !data || data === "[DONE]" || JSON.parse(data).type !== "ping";
    })
    .map((frame) => `${frame}\n\n`)
    .join("");
}

const captureOriginal = `${imports}
export default {apiVersion:1,id:"capture",unsafe:true,timeoutMs:5000,raw:{async response(ctx){
  writeFileSync(join(process.env.HOME,"original.sse"),new Uint8Array(await ctx.response.arrayBuffer()));
}}};`;

describe("FR-6 / FR-8 exact raw parser rows X-1–X-4 (§11.5)", () => {
  test("X-1 mutated chunk followed by rejecting thenable is discarded without unhandled rejection", async () => {
    const code = `${imports}
      process.on("unhandledRejection",()=>writeFileSync(join(process.env.HOME,"unhandled"),"BAD"));
      ${rawHook('providerChunk(ctx){if(!ctx.delta?.content)return;ctx.delta.content="CORRUPTED";return Promise.reject(new Error("x"))},async providerStreamEnd(){await new Promise(setImmediate);writeFileSync(join(process.env.HOME,"rejection-barrier"),"DONE")}')}`;
    const f = await fixture(code);
    expect(textOf(await f.read())).toBe("original");
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "error");
    await until(
      () => existsSync(join(f.ws.layout.home, "rejection-barrier")),
      "a child event-loop rejection barrier"
    );
    const rows = userRows(f.ws);
    expect(
      rows.some((r) => r.decision === "invalid" && (r.detail ?? "").includes("async_return"))
    ).toBe(true);
    expect(rows.some((r) => r.decision === "error")).toBe(true);
    expect(existsSync(join(f.ws.layout.home, "unhandled"))).toBe(false);
  }, 20000);

  test("X-2 eight mutated thenables yield original text, exactly five invalids and one disable", async () => {
    const code = `${imports}${rawHook('providerChunk(ctx){if(!ctx.delta?.content)return;appendFileSync(join(process.env.HOME,"calls"),"CALL\\n");ctx.delta.content="CORRUPTED";return Promise.resolve()}')}`;
    const f = await fixture(code, { script: [{ parts: [{ text: "abcdefgh" }], deltaChars: 1 }] });
    expect(textOf(await f.read())).toBe("abcdefgh");
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "disabled");
    expect(
      userRows(f.ws).filter(
        (r) => r.decision === "invalid" && (r.detail ?? "").includes("async_return")
      )
    ).toHaveLength(5);
    expect(userRows(f.ws).filter((r) => r.decision === "disabled")).toHaveLength(1);
    expect(readFileSync(join(f.ws.layout.home, "calls"), "utf8").trim().split("\n")).toEqual(
      Array(5).fill("CALL")
    );
    expect(
      (f.ws.diagnostics(f.process).match(/disabled after 5 consecutive failures/g) ?? []).length
    ).toBe(1);
  }, 20000);

  test("X-3 declared async chunk is rejected, but the valid sibling remains registered", async () => {
    const code = `export default [
      {apiVersion:1,id:"bad",unsafe:true,raw:{async providerChunk(ctx){ctx.delta.content="CORRUPTED"}}},
      {apiVersion:1,id:"good",on:{responseRewrite:{handle(){return [{type:"appendText",text:"-GOOD"}]}}}}
    ];`;
    const f = await fixture(code);
    expect(textOf(await f.read())).toBe("original-GOOD");
    const check = await f.ws.cli([
      "hooks",
      "check",
      f.ws.config.hooks ? (f.ws.config.hooks as { modules: string[] }).modules[0]! : "",
    ]);
    expect(check.code).toBe(1);
    expect(check.stdout + check.stderr).toContain("raw.providerChunk must be synchronous");
    expect(f.process.stderr).toContain("raw.providerChunk must be synchronous");
    const result = await f.ws.cli(["hooks", "list", "--json"]);
    expect(result.code).toBe(0);
    const listed = JSON.parse(result.stdout) as { hooks: Array<{ id: string }> };
    expect(listed.hooks.filter((h) => h.id.startsWith("hook:sample/")).map((h) => h.id)).toEqual([
      "hook:sample/good",
    ]);
  }, 30000);

  for (const severity of ["fix", "warn"]) {
    test(`X-4 ${severity} governs committed delta deletion, text replacement and finish_reason`, async () => {
      const url = replayProvider([
        { delta: { role: "assistant", content: "" } },
        { delta: { reasoning_content: "R" } },
        { delta: { content: "original" } },
        { delta: {}, finish: "length" },
      ]);
      const code = rawHook(
        'providerChunk(ctx){if(ctx.delta){delete ctx.delta.reasoning_content;if("content" in ctx.delta && ctx.delta.content)ctx.delta.content="rewritten"}if(ctx.chunk.choices?.[0]?.finish_reason==="length")ctx.chunk.choices[0].finish_reason="stop"}'
      );
      const f = await fixture(code, {
        endpointUrl: url,
        hooks: { severity: { "hook:sample/*": severity } },
      });
      const raw = await f.read();
      expect({
        text: textOf(raw),
        reasoning: thinkingOf(raw),
        stop: events(raw).find((e) => e.type === "message_delta")?.delta?.stop_reason,
      }).toEqual(
        severity === "fix"
          ? { text: "rewritten", reasoning: "", stop: "end_turn" }
          : { text: "original", reasoning: "R", stop: "max_tokens" }
      );
      expect(
        events(raw).filter(
          (e) => e.type === "content_block_start" && e.content_block?.type === "thinking"
        )
      ).toHaveLength(severity === "fix" ? 0 : 1);
      if (severity === "warn")
        await waitJournal(
          f.ws,
          (r) => r.hookId === "hook:sample/test" && r.event === "raw" && r.decision === "warned"
        );
    }, 20000);
  }
});

describe("FR-6 / FR-8 raw request clone-and-commit and response atomicity", () => {
  test("RAW-1 emptied provider messages followed by throw leaves transport request unchanged", async () => {
    const f = await fixture(
      rawHook(
        'providerRequest(ctx){ctx.messages.length=0;ctx.claudeRequest.messages.length=0;throw new Error("RAW-FAIL")}'
      )
    );
    expect(textOf(await f.read())).toBe("original");
    expect(userMessage(f)).toEqual([{ role: "user", content: "HELLO" }]);
    await waitJournal(
      f.ws,
      (r) => r.hookId === "hook:sample/test" && r.event === "raw" && r.decision === "error"
    );
  }, 20000);

  test("RAW-2 timeout and post-timeout mutation cannot reach the transport", async () => {
    const code = `${imports}${rawHook('providerRequest(ctx){ctx.messages.length=0;return new Promise(resolve=>setTimeout(()=>{ctx.messages.push({role:"user",content:"LATE"});writeFileSync(join(process.env.HOME,"late-mutation"),"YES");resolve()},200))}', "timeoutMs:50,")}`;
    const f = await fixture(code);
    expect(textOf(await f.read())).toBe("original");
    await until(
      () => existsSync(join(f.ws.layout.home, "late-mutation")),
      "a mutation after the raw timeout"
    );
    expect(userMessage(f)).toEqual([{ role: "user", content: "HELLO" }]);
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "timeout");
  }, 20000);

  for (const severity of ["fix", "warn", "off"]) {
    test(`RAW-3 ${severity} determines whether raw provider edits reach the transport`, async () => {
      const f = await fixture(
        rawHook('providerRequest(ctx){ctx.messages.find(m=>m.role==="user").content="CHANGED"}'),
        { hooks: { severity: { "hook:sample/*": severity } } }
      );
      await f.read();
      expect(userMessage(f)).toEqual([
        { role: "user", content: severity === "fix" ? "CHANGED" : "HELLO" },
      ]);
      if (severity !== "off")
        await waitJournal(
          f.ws,
          (r) =>
            r.hookId === "hook:sample/test" &&
            r.decision === (severity === "warn" ? "warned" : "raw")
        );
      expect(f.process.stderr).toContain("UNSAFE (raw middleware)");
    }, 20000);
  }

  test("RAW-4 a replacement that errors after a valid first chunk forwards only original bytes", async () => {
    const replacement = stubEvents("anthropic-sse", { parts: [{ text: "CORRUPTED" }] }).join("");
    const bad = rawHook(
      `response(){return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(${JSON.stringify(replacement)}));setTimeout(()=>c.error(new Error("replacement failed")),20)}}),{headers:{"content-type":"text/event-stream"}})}`
    );
    const f = await startProxy({
      modules: [
        { name: "capture.ts", code: captureOriginal },
        { name: "sample.ts", code: bad },
      ],
    });
    fixtures.push(f);
    const raw = await f.read();
    const original = readFileSync(join(f.ws.layout.home, "original.sse"), "utf8");
    expect(withoutPings(raw)).toBe(withoutPings(original));
    expect(textOf(raw)).toBe("original");
    expect(raw).not.toContain("CORRUPTED");
    expect(events(raw).filter((e) => e.type === "error")).toEqual([]);
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "error");
  }, 20000);

  for (const readTwo of [false, true]) {
    test(`X-6/X-7 ${readTwo ? "partly read" : "ignored"} replay plus never-closing replacement times out atomically`, async () => {
      const firstChunk = stubEvents("anthropic-sse", { parts: [{ text: "CORRUPTED" }] }).join("");
      const code = `${imports}${rawHook(
        `async response(ctx){${readTwo ? "const r=ctx.response.body.getReader();await r.read();await r.read();" : ""}
        return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(${JSON.stringify(firstChunk)}))},cancel(){appendFileSync(join(process.env.HOME,"cancelled"),"CANCEL\\n")}}),{headers:{"content-type":"text/event-stream"}})
      }`,
        "timeoutMs:1500,"
      )}`;
      const f = await startProxy({
        modules: [
          { name: "capture.ts", code: captureOriginal },
          { name: "sample.ts", code },
        ],
        script: [{ parts: [{ text: "abcdefgh" }], deltaChars: 1 }],
      });
      fixtures.push(f);
      const raw = await f.read();
      expect(textOf(raw)).toBe("abcdefgh");
      expect(withoutPings(raw)).toBe(
        withoutPings(readFileSync(join(f.ws.layout.home, "original.sse"), "utf8"))
      );
      expect(events(raw).some((e) => e.type === "ping")).toBe(true);
      expect(events(raw).filter((e) => e.type === "error")).toEqual([]);
      expect(raw).not.toContain("CORRUPTED");
      await until(
        () => existsSync(join(f.ws.layout.home, "cancelled")),
        "replacement cancellation"
      );
      expect(readFileSync(join(f.ws.layout.home, "cancelled"), "utf8")).toBe("CANCEL\n");
      await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "timeout");
    }, 20000);
  }

  test("X-8 unread replay returning nothing permits incremental original delivery", async () => {
    const gate = gatedProvider();
    const f = await fixture(rawHook("response(){return undefined}"), { endpointUrl: gate.url });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await f.fetch();
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      const prefix = await readUntil(reader, (raw) => textOf(raw) === "FIRST");
      expect(gate.released).toBe(false);
      gate.release();
      let tail = "";
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        tail += decoder.decode(next.value, { stream: true });
      }
      expect(textOf(prefix + tail + decoder.decode())).toBe("FIRSTSECOND");
      await until(() => f.ws.debug().includes("mode=none raw=1 tap=0"), "raw-only seam diagnostic");
      expect(f.ws.debug()).toContain("mode=none raw=1 tap=0");
      expect(
        userRows(f.ws).filter((r) => ["error", "invalid", "timeout"].includes(r.decision))
      ).toEqual([]);
    } finally {
      gate.release();
      await reader?.cancel().catch(() => {});
      gate.stop();
    }
  }, 20000);

  for (const severity of ["fix", "warn"]) {
    test(`RAW-5/RAW-6 ${severity} raw replacement controls client bytes and responseEnd view`, async () => {
      const replacement = stubEvents("anthropic-sse", { parts: [{ text: "REPLACEMENT" }] }).join(
        ""
      );
      const code = `${imports}export default {apiVersion:1,id:"test",unsafe:true,raw:{response(){return new Response(${JSON.stringify(replacement)},{headers:{"content-type":"text/event-stream"}})}},on:{responseEnd(ctx){writeFileSync(join(process.env.HOME,"end-text"),ctx.response.text)}}};`;
      const f = await fixture(code, { hooks: { severity: { "hook:sample/*": severity } } });
      const raw = await f.read();
      const expected = severity === "fix" ? "REPLACEMENT" : "original";
      expect(textOf(raw)).toBe(expected);
      await until(
        () => existsSync(join(f.ws.layout.home, "end-text")),
        "responseEnd after a raw replacement"
      );
      expect(readFileSync(join(f.ws.layout.home, "end-text"), "utf8")).toBe(expected);
      if (severity === "warn")
        await waitJournal(
          f.ws,
          (r) => r.hookId === "hook:sample/test" && r.event === "raw" && r.decision === "warned"
        );
    }, 20000);
  }

  test("RAW-7 a thrown raw response handler fails open with original text", async () => {
    const f = await fixture(rawHook('response(){throw new Error("RAW-RESPONSE-FAIL")}'));
    const raw = await f.read();
    expect(textOf(raw)).toBe("original");
    expect(events(raw).filter((e) => e.type === "error")).toEqual([]);
    await waitJournal(f.ws, (r) => r.hookId === "hook:sample/test" && r.decision === "error");
  }, 20000);
});
