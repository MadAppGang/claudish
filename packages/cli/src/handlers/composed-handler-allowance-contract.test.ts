import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Reuse the permitted, isolated Phase-2a pool/transport setup. Upstream bodies
// are captures, not an invented Responses protocol. Quota headers are the
// existing E19 loopback setup, not evidence of a live vendor's behavior.
const src = resolve(import.meta.dir, "..");
const setup = readFileSync(join(import.meta.dir, "composed-handler-accounts-2a.test.ts"), "utf8");
const original = setup.match(/const program = String.raw`([\s\S]*?)`;/)![1]!;
const program = original
  .replace(
    "async function upstream(req) {",
    `let releaseOverlap, reachedOverlap;
const overlapGate = new Promise(resolve => { releaseOverlap = resolve; });
const overlapReached = new Promise(resolve => { reachedOverlap = resolve; });
let overlapReadCount = null;
async function upstream(req) {`
  )
  .replace(
    'const bearer = req.headers.get("authorization");',
    String.raw`
  const bearer = req.headers.get("authorization");
  if (scenario.startsWith("R-allowance")) {
    contacts.push({bearer});
    if (scenario.includes("overlap") && contacts.length === 2) { reachedOverlap(); await overlapGate; }
    const headers={"content-type":"text/event-stream","x-codex-primary-used-percent":bearer === "Bearer access-A" ? "100" : "20","x-codex-primary-window-minutes":"300","x-codex-primary-reset-at":String(reset),"x-codex-plan-type":scenario.endsWith("secret") ? "access-B" : "pro"};
    if (scenario.includes("rotate") && bearer === "Bearer access-A")
      return Response.json({error:{type:"usage_limit_reached",message:"You have hit your usage limit",resets_at:reset}}, {status:429,headers});
    if (scenario.includes("legs")) {
      let stream=responseCapture(contacts.length===1 ? "codex-parallel-degenerate-stall.sse" : "codex-zero-delta-multicall.sse");
      if(scenario.includes("legs-cache") && contacts.length===1) {
        // Derived solely from captures: put exec-turn1's unmodified billed
        // usage object on the captured malformed leg, so its cache is nonzero.
        const usage=responseCapture("codex-exec-turn1.sse").split("\n").filter(l=>l.startsWith("data: ")).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==="response.completed").response.usage;
        stream=stream.split("\n").map(l=>{
          if(!l.startsWith("data: "))return l;
          const event=JSON.parse(l.slice(6));
          if(event.type==="response.incomplete")event.response.usage=usage;
          return "data: "+JSON.stringify(event);
        }).join("\n");
      }
      return new Response(stream,{headers});
    }
    return new Response(responseCapture(scenario.includes("cache") ? "codex-exec-turn2.sse" : "codex-zero-delta-multicall.sse"),{headers});
  }`
  )
  .replace(
    'messages: [{ role: "user", content: c.req.header("x-test-turn") ?? "hello" }],',
    'metadata: {user_id:JSON.stringify({session_id:"s-123",other:"PRIVATE METADATA"})}, system:"PRIVATE SYSTEM PROMPT", messages: [{ role: "user", content: "PRIVATE USER PROMPT" }],'
  )
  .replace(
    'const { Hono } = await import("hono");',
    String.raw`
  const { spyOn } = await import("bun:test");
  const ledgerReader = await import(src + "/auth/accounts/ledger/ledger-reader.ts");
  const originalRead = ledgerReader.readLedger;
  let responseFinished = false, responseStarted = false;
  const ledgerReadAt = [];
  spyOn(ledgerReader, "readLedger").mockImplementation((...args) => { ledgerReadAt.push({started:responseStarted,finished:responseFinished}); return originalRead(...args); });
  const { Hono } = await import("hono");`
  )
  .replace(
    'const response = await app.request("http://localhost/v1/messages", { method: "POST" });',
    String.raw`let response;
    if (scenario.includes("overlap")) {
      const first = await app.request("http://localhost/v1/messages", { method: "POST" });
      const second = app.request("http://localhost/v1/messages", { method: "POST" });
      await overlapReached;
      await first.text();
      await Bun.sleep(1100);
      overlapReadCount = ledgerReadAt.length;
      releaseOverlap();
      response = await second;
    } else response = await app.request("http://localhost/v1/messages", { method: "POST" });
    responseStarted = true;`
  )
  .replace(
    "const text = await response.text();",
    "const text = await response.text(); responseFinished = true;"
  )
  .replace(
    "const state = getStateStore().read().state;",
    String.raw`
  const { flushUsageLedger } = await import(src + "/auth/accounts/ledger/ledger-writer.ts");
  await flushUsageLedger();
  if (scenario.includes("overlap")) {
    await Bun.sleep(1100);
    const { getAllowanceService } = await import(src + "/auth/accounts/allowance-service.ts");
    await getAllowanceService().settled("openai-codex");
  }
  const { readdirSync, statSync } = await import("node:fs");
  const raw=join(process.env.CLAUDISH_ACCOUNTS_DIR,"usage","raw");
  const ledgerFiles=(()=>{try{return readdirSync(raw)}catch{return []}})();
  const bytes=ledgerFiles.map(name=>readFileSync(join(raw,name),"utf8")).join("");
  let ledger=bytes.trim()?bytes.trim().split("\n").map(JSON.parse):[];
  let disposedLabel = null;
  if (scenario.includes("dispose")) {
    const { getAllowanceService } = await import(src + "/auth/accounts/allowance-service.ts");
    const svc = getAllowanceService();
    await svc.evaluateAlerts("openai-codex");
    const labelBefore = svc.labelFor("openai-codex");
    const setter = spyOn(tracker, "setAllowanceLabel");
    await handler.shutdown();
    setter.mockClear();
    await svc.evaluateAlerts("openai-codex");
    disposedLabel = { before: labelBefore, after: svc.labelFor("openai-codex"), calls: setter.mock.calls.length };
    setter.mockRestore();
  }
  if(process.env.ALLOWANCE_MUTATION==="single-draft")ledger=ledger.slice(-1);
  if(process.env.ALLOWANCE_MUTATION==="session-null")ledger=ledger.map(r=>({...r,session:null}));
  if(process.env.ALLOWANCE_MUTATION==="last-leg")ledger=ledger.map(r=>({...r,inTok:r.finalInTok,outTok:179}));
  if(process.env.ALLOWANCE_MUTATION==="cache-drop")ledger=ledger.map(r=>({...r,cacheReadTok:0}));
  console.log("ALLOWANCE "+JSON.stringify({disposedLabel,overlapReadCount,ledgerReadAt,ledger,bytes:process.env.ALLOWANCE_MUTATION==="secret-echo"?bytes+"access-B":bytes,modes:ledgerFiles.map(name=>statSync(join(raw,name)).mode&511)}));
  const state = getStateStore().read().state;`
  );
async function run(scenario: string, mutation = process.env.ALLOWANCE_MUTATION ?? "") {
  const home = mkdtempSync(join(tmpdir(), "allowance-handler-contract-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", program], {
      cwd: resolve(src, ".."),
      env: {
        ...process.env,
        HOME: home,
        TZ: "UTC",
        CLAUDISH_CONFIG: join(home, "config.json"),
        CLAUDISH_ACCOUNTS_DIR: join(home, "accounts"),
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_SKIP_LIVE_E2E: "1",
        CLAUDISH_ACCOUNTS_LOG: join(home, "accounts.jsonl"),
        CLAUDISH_ACCOUNTS_FAULT: "",
        CLAUDISH_TEST_UPSTREAM: "",
        CLAUDISH_ALLOWANCE_LEDGER: "on",
        TEST_SRC: src,
        SCENARIO: scenario,
        MUTATION: "",
        ALLOWANCE_MUTATION: mutation,
        OPENAI_CODEX_API_KEY: "metered-test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const code = await child.exited;
    const text = await output;
    const stderr = await errors;
    if (code !== 0) throw new Error("handler child " + code + "\n" + stderr + "\n" + text);
    const result = text.split("\n").find((l) => l.startsWith("RESULT "));
    const allowance = text.split("\n").find((l) => l.startsWith("ALLOWANCE "));
    if (!result || !allowance) throw new Error(text + "\n" + stderr);
    return { ...JSON.parse(result.slice(7)), ...JSON.parse(allowance.slice(10)), stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
describe("allowance real handler loopback integration", () => {
  test("30 sticky never reads the ledger before the handler returns a response", async () => {
    const r = await run("R-allowance-rotate");
    expect(r.status).toBe(200);
    expect(
      r.ledgerReadAt.filter((phase: { started: boolean; finished: boolean }) => !phase.started)
    ).toEqual([]);
  }, 30_000);
  test("F3 settling A does not read the ledger while overlapping request B waits upstream", async () => {
    const r = await run("R-allowance-overlap");
    expect(r.status).toBe(200);
    expect(r.contacts).toHaveLength(2);
    expect(r.overlapReadCount).toBe(0);
    expect(r.ledgerReadAt.length).toBeGreaterThan(0);
    expect(r.ledger).toHaveLength(2);
  }, 30000);
  test("L5 handler shutdown detaches its tracker from later allowance labels", async () => {
    const r = await run("R-allowance-dispose");
    expect(r.status).toBe(200);
    expect(r.ledger).toHaveLength(1);
    expect(r.disposedLabel.before).toBeDefined();
    expect(r.disposedLabel.after).toBeDefined();
    expect(r.disposedLabel.calls).toBe(0);
  }, 30_000);
  test("33a quota A and success B produce two attempt rows, never one shared draft", async () => {
    const r = await run("R-allowance-rotate");
    expect(r.status).toBe(200);
    expect(r.contacts.map((c: { bearer: string }) => c.bearer)).toEqual([
      "Bearer access-A",
      "Bearer access-B",
    ]);
    expect(r.ledger).toHaveLength(2);
    const [quota, ok] = r.ledger;
    expect(quota).toMatchObject({
      accountId: "aaaaaaaaaaaa",
      outcome: "quota",
      inTok: 0,
      cacheReadTok: 0,
      outTok: 0,
    });
    expect(quota.windows[0]).toMatchObject({ usedFraction: 1, lengthMinutes: 300 });
    expect(ok).toMatchObject({
      accountId: "bbbbbbbbbbbb",
      outcome: "ok",
      inTok: 39429,
      outTok: 179,
      finalInTok: 39429,
    });
    expect(quota.id).toEndWith(":0:aaaaaaaaaaaa");
    expect(ok.id).toEndWith(":1:bbbbbbbbbbbb");
    expect(r.modes).toEqual([0o600]);
    expect(r.ledger.some((row: { kind: string }) => row.kind === "no-eligible")).toBe(false);
  }, 30_000);
  test("33b whole request metadata supplies session id on every attempt", async () => {
    const r = await run("R-allowance-rotate");
    expect(r.ledger).toHaveLength(2);
    expect(r.ledger.map((row: { session: string | null }) => row.session)).toEqual([
      "s-123",
      "s-123",
    ]);
  }, 30_000);
  test("33c Responses in-turn retry sums both captured billed legs", async () => {
    const r = await run("R-allowance-legs");
    expect(r.status).toBe(200);
    expect(r.contacts).toHaveLength(2);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({
      inTok: 78858,
      cacheReadTok: 0,
      outTok: 32179,
      finalInTok: 39429,
      outcome: "ok",
    });
  }, 30_000);
  test("33c cache on an earlier derived captured leg is retained after retry", async () => {
    const r = await run("R-allowance-legs-cache");
    expect(r.status).toBe(200);
    expect(r.contacts).toHaveLength(2);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({
      inTok: 70107,
      cacheReadTok: 13312,
      outTok: 313,
      finalInTok: 39429,
    });
  }, 30_000);
  test("33c cache detail from a captured Responses completion reaches the ledger", async () => {
    const r = await run("R-allowance-cache");
    expect(r.status).toBe(200);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({
      inTok: 31022,
      cacheReadTok: 30464,
      outTok: 40,
      finalInTok: 31022,
    });
  }, 30_000);
  test("33d rows store closed plan classes and no prompt or signing value", async () => {
    const normal = await run("R-allowance-rotate");
    const secret = await run("R-allowance-rotate-secret");
    expect(normal.ledger.map((r: { planClass: string }) => r.planClass)).toEqual(["pro", "pro"]);
    expect(secret.ledger.map((r: { planClass: string }) => r.planClass)).toEqual([
      "other",
      "other",
    ]);
    for (const r of [normal, secret]) {
      for (const forbidden of [
        "PRIVATE USER PROMPT",
        "PRIVATE SYSTEM PROMPT",
        "PRIVATE METADATA",
        "access-A",
        "access-B",
      ])
        expect(r.bytes).not.toContain(forbidden);
      for (const row of r.ledger) {
        expect(row.session).toMatch(/^[A-Za-z0-9-]{1,64}$/);
        expect(row.model.length).toBeLessThanOrEqual(80);
        expect(row.label).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    }
  }, 30_000);
});
