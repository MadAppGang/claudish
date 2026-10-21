import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ProxyFixture,
  hook,
  startProxy,
  textOf,
  until,
  userRows,
  waitJournal,
} from "./support.ts";

const fixtures: ProxyFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const imports = 'import {writeFileSync} from "node:fs";import {join} from "node:path";';

// This file intentionally does not claim a delivered turn, idle/dialog safety, or any H-row.
describe("FR-3 / FR-5 no-surface session and injection failure paths (§4.4–4.7)", () => {
  test("N-1 sessionStart fires at spawn even when proxy model/route filters do not match", async () => {
    const code = `${imports}${hook('sessionStart(ctx){writeFileSync(join(process.env.HOME,"start.json"),JSON.stringify({event:ctx.event,session:ctx.session}));return [{type:"warn",message:"STARTED"}]}', 'models:"not-the-test-model",routes:"native",')}`;
    const f = await startProxy({ modules: [{ name: "sample.ts", code }] });
    fixtures.push(f);
    const file = join(f.ws.layout.home, "start.json");
    await until(() => existsSync(file), "no-surface sessionStart");
    const ctx = JSON.parse(readFileSync(file, "utf8"));
    expect({
      event: ctx.event,
      kind: ctx.session.kind,
      role: ctx.session.role,
      cwd: ctx.session.cwd,
      injection: ctx.session.injection,
    }).toEqual({
      event: "sessionStart",
      kind: "interactive",
      role: null,
      cwd: f.ws.layout.cwd,
      injection: "unavailable",
    });
    expect(textOf(await f.read())).toBe("original");
    await waitJournal(
      f.ws,
      (r) => r.hookId === "hook:sample/test" && r.event === "sessionStart" && r.action === "warn"
    );
  }, 20000);

  test("N-2 responseEnd injection without a surface is dropped, never blocks, and warns once", async () => {
    const f = await startProxy({
      modules: [
        {
          name: "sample.ts",
          code: hook('responseEnd(){return [{type:"injectUserTurn",text:"HOOK-PING"}]}'),
        },
      ],
    });
    fixtures.push(f);
    for (let n = 0; n < 2; n++) expect(textOf(await f.read())).toBe("original");
    await until(
      () =>
        userRows(f.ws).filter(
          (r) =>
            r.action === "injectUserTurn" &&
            r.decision === "dropped" &&
            (r.detail ?? "").includes("unavailable")
        ).length === 2,
      "both unavailable injections"
    );
    const diagnostic =
      "hook injection dropped: this claudish process has no Claude Code session to deliver it to";
    expect(f.ws.diagnostics(f.process).split(diagnostic)).toHaveLength(2);
    expect(f.stub.requests).toHaveLength(2);
    expect(f.process.stdout).not.toContain("HOOK-PING");
  }, 20000);

  for (const [name, text, detail] of [
    ["leading-whitespace slash command", " \t/clear", "slash_command"],
    ["empty text", "", ""],
    ["more than 100000 chars", "x".repeat(100001), ""],
  ]) {
    test(`N-3 ${name} is invalid before an injection can be queued`, async () => {
      const f = await startProxy({
        modules: [
          {
            name: "sample.ts",
            code: hook(
              `responseEnd(){return [{type:"injectUserTurn",text:${JSON.stringify(text)}}]}`
            ),
          },
        ],
      });
      fixtures.push(f);
      expect(textOf(await f.read())).toBe("original");
      await waitJournal(
        f.ws,
        (r) =>
          r.hookId === "hook:sample/test" &&
          r.action === "injectUserTurn" &&
          r.decision === "invalid"
      );
      const rows = userRows(f.ws).filter((r) => r.action === "injectUserTurn");
      expect(rows.some((r) => r.decision === "queued" || r.decision === "delivered")).toBe(false);
      if (detail) expect(rows.some((r) => (r.detail ?? "").includes(detail!))).toBe(true);
    }, 20000);
  }

  test("N-4 unavailable annotation is journaled without a user-facing injection warning", async () => {
    const f = await startProxy({
      modules: [
        {
          name: "sample.ts",
          code: hook('responseEnd(){return [{type:"annotateTurn",key:"ran-command",value:true}]}'),
        },
      ],
    });
    fixtures.push(f);
    expect(textOf(await f.read())).toBe("original");
    await waitJournal(
      f.ws,
      (r) =>
        r.hookId === "hook:sample/test" &&
        r.action === "annotateTurn" &&
        r.decision === "dropped" &&
        (r.detail ?? "").includes("unavailable")
    );
    expect(f.ws.diagnostics(f.process)).not.toContain("hook injection dropped:");
  }, 20000);

  for (const condition of ["throw", "hang"]) {
    test(`N-4 ${condition} in sessionStart cannot prevent a proxy request from succeeding`, async () => {
      const body =
        condition === "throw" ? 'throw new Error("START-FAIL")' : "return new Promise(()=>{})";
      const f = await startProxy({
        modules: [{ name: "sample.ts", code: hook(`sessionStart(){${body}}`, "timeoutMs:50,") }],
      });
      fixtures.push(f);
      expect(textOf(await f.read())).toBe("original");
      await waitJournal(
        f.ws,
        (r) =>
          r.hookId === "hook:sample/test" &&
          r.event === "sessionStart" &&
          r.decision === (condition === "throw" ? "error" : "timeout")
      );
    }, 20000);
  }

  test("N-5 sessionEnd fires when the fake Claude exits and exposes exitCode zero", async () => {
    const code = `${imports}${hook('sessionEnd(ctx){writeFileSync(join(process.env.HOME,"end-session.json"),JSON.stringify({event:ctx.event,session:ctx.session,outcome:ctx.outcome}))}')}`;
    const f = await startProxy({ modules: [{ name: "sample.ts", code }] });
    fixtures.push(f);
    expect(textOf(await f.read())).toBe("original");
    f.process.write("/exit\r");
    expect(await f.process.finish()).toBe(0);
    const ctx = JSON.parse(readFileSync(join(f.ws.layout.home, "end-session.json"), "utf8"));
    expect({ event: ctx.event, kind: ctx.session.kind, exitCode: ctx.outcome.exitCode }).toEqual({
      event: "sessionEnd",
      kind: "interactive",
      exitCode: 0,
    });
  }, 20000);
});
