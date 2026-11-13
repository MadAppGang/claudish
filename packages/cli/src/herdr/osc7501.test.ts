import { describe, expect, test } from "bun:test";
import type { ViewItem } from "../pane/view-contract.js";
import { chooseFrontEnd, parseViewArgs } from "../view/view-cli.js";
import { PLAIN_TERMINAL } from "../view/viewer.js";
import { HcStatusReporter } from "./hc-reporter.js";
import { clearOsc7501, decodeOsc7501, encodeOsc7501 } from "./osc7501.js";
import { hcStatus } from "./state-map.js";
import { replayItem, sessionItem } from "./test-helpers/view-items.js";

const ESC = "\x1b";

function withFields(item: ViewItem, fields: Record<string, unknown>): ViewItem {
  return { ...item, ...fields } as ViewItem;
}

describe("encodeOsc7501", () => {
  test("is byte for byte the line hc 0.1.19 parsed into status {state, app, title, msg}", () => {
    // the line from the herdr-core spike: `hc get` answered
    // "status":{"app":"claudish","msg":"Bash","state":"working","title":"claudish · gpt-6 spike"}
    expect(
      encodeOsc7501({
        state: "working",
        app: "claudish",
        title: "claudish · gpt-6 spike",
        msg: "Bash",
      })
    ).toBe(
      `${ESC}]7501;state=working:app=claudish:title=Y2xhdWRpc2ggwrcgZ3B0LTYgc3Bpa2U=:msg=QmFzaA==${ESC}\\`
    );
  });

  test("title and message are base64, so a ':' or a control character cannot split the line", () => {
    const line = encodeOsc7501({ state: "idle", title: "a:b\x1b]c", msg: "x\x07y" });
    expect(line.slice(2, -2)).not.toContain(ESC);
    expect(line).not.toContain("\x07");
    expect(line.split(":")).toHaveLength(3);
    expect(decodeOsc7501(line)).toEqual({ state: "idle", title: "a:b\x1b]c", msg: "x\x07y" });
  });

  test("kind goes out only on blocked; empty fields are left out", () => {
    expect(encodeOsc7501({ state: "blocked", kind: "permission", app: "claudish" })).toBe(
      `${ESC}]7501;state=blocked:kind=permission:app=claudish${ESC}\\`
    );
    expect(encodeOsc7501({ state: "working", kind: "permission", title: "" })).toBe(
      `${ESC}]7501;state=working${ESC}\\`
    );
  });

  test("an app name hc would not keep verbatim is refused", () => {
    expect(() => encodeOsc7501({ state: "idle", app: "clau dish" })).toThrow();
    expect(() => encodeOsc7501({ state: "idle", app: "a:b" })).toThrow();
  });

  test("clear drops the report", () => {
    expect(clearOsc7501()).toBe(`${ESC}]7501;state=clear${ESC}\\`);
    expect(decodeOsc7501(clearOsc7501())).toEqual({ state: "clear" });
  });

  test("decode accepts the BEL terminator hc also parsed, and refuses other bytes", () => {
    expect(decodeOsc7501(`${ESC}]7501;state=idle:app=claudish\x07`)).toEqual({
      state: "idle",
      app: "claudish",
    });
    expect(decodeOsc7501(`${ESC}]7502;state=idle${ESC}\\`)).toBeNull();
    expect(decodeOsc7501("state=idle")).toBeNull();
  });
});

describe("hcStatus", () => {
  test.each([
    ["STARTING", null, "working", undefined],
    ["RUNNING", "Bash", "working", undefined],
    ["AWAITING_PERMISSION", "Bash", "blocked", "permission"],
    ["AWAITING_INPUT", "AskUserQuestion", "blocked", "question"],
    ["AWAITING_INPUT", null, "idle", undefined],
    ["COMPLETED", null, "done", undefined],
    ["EMPTY", null, "done", undefined],
    ["CANCELLED", null, "done", undefined],
    ["FAILED", null, "error", undefined],
    ["TIMEOUT", null, "error", undefined],
  ] as const)("%s with activity %s → %s", (state, activity, want, kind) => {
    const s = hcStatus(withFields(sessionItem("a"), { state, activity }));
    expect(s.state).toBe(want);
    expect(s.kind).toBe(kind);
  });

  test("title follows the prompt summary, or the model with titleMode model; msg names the state", () => {
    const running = withFields(sessionItem("a"), { activity: "Bash" });
    expect(hcStatus(running)).toEqual({ state: "working", title: "say hi", msg: "Bash" });
    expect(hcStatus(running, { titleMode: "model" }).title).toBe("gpt-6");
    const failed = withFields(sessionItem("a"), { state: "FAILED", reason: "api_error" });
    expect(hcStatus(failed).msg).toBe("FAILED (api_error)");
    expect(hcStatus(replayItem("r1", true))).toEqual({
      state: "idle",
      title: "gpt-6",
      msg: "replay ended",
    });
  });
});

describe("HcStatusReporter", () => {
  test("writes one line per change of what it says, and clears it at the end", () => {
    const out: string[] = [];
    const r = new HcStatusReporter({ write: (s) => out.push(s) });
    r.report({ item: null, ended: false });
    expect(out).toEqual([]);
    const running = withFields(sessionItem("a"), { activity: "Bash" });
    r.report({ item: running, ended: false });
    r.report({ item: { ...running, tokens_in: 5 } as ViewItem, ended: false });
    expect(out).toHaveLength(1);
    expect(decodeOsc7501(out[0] as string)).toEqual({
      state: "working",
      app: "claudish",
      title: "say hi",
      msg: "Bash",
    });
    r.report({
      item: withFields(running, { state: "AWAITING_PERMISSION" }),
      ended: false,
    });
    expect(decodeOsc7501(out[1] as string)).toMatchObject({ state: "blocked", kind: "permission" });
    r.close();
    r.close();
    expect(out.slice(2)).toEqual([clearOsc7501()]);
    r.report({ item: running, ended: true });
    expect(out).toHaveLength(3);
  });

  test("a reporter that never reported writes nothing at the end", () => {
    const out: string[] = [];
    new HcStatusReporter({ write: (s) => out.push(s) }).close();
    expect(out).toEqual([]);
  });
});

describe("the viewer's front end choice", () => {
  test("--front-end herdr-core is accepted", () => {
    expect(parseViewArgs(["s:a", "--front-end", "herdr-core"])).toMatchObject({
      target: "s:a",
      frontEnd: "herdr-core",
    });
  });

  test("in an hc terminal, auto and herdr-core report by OSC 7501 to the viewer's own output", () => {
    const hcEnv = { HC_TERMINAL_ID: "t7", TERM_PROGRAM: "ghostty" };
    for (const wanted of ["auto", "herdr-core"] as const) {
      const out: string[] = [];
      const choice = chooseFrontEnd(wanted, hcEnv, (s) => out.push(s));
      if ("error" in choice) throw new Error(choice.error);
      expect(choice.frontEnd).toBeInstanceOf(HcStatusReporter);
      expect(choice.frontEnd.name).toBe("herdr-core");
      choice.frontEnd.report({ item: sessionItem("a"), ended: false });
      expect(out).toHaveLength(1);
      expect(out[0]?.startsWith(`${ESC}]7501;state=working:app=claudish`)).toBe(true);
    }
  });

  test("outside an hc terminal no OSC 7501 line is ever written", () => {
    const out: string[] = [];
    const auto = chooseFrontEnd("auto", { TERM_PROGRAM: "iTerm.app" }, (s) => out.push(s));
    expect(auto).toEqual({ frontEnd: PLAIN_TERMINAL });
    expect(chooseFrontEnd("herdr-core", {}, (s) => out.push(s))).toEqual({
      error: "--front-end herdr-core needs an hc terminal (HC_TERMINAL_ID)",
    });
    const off = chooseFrontEnd("auto", { HC_TERMINAL_ID: "t7", CLAUDISH_HERDR: "0" }, (s) =>
      out.push(s)
    );
    expect(off).toEqual({ frontEnd: PLAIN_TERMINAL });
    expect(out).toEqual([]);
  });
});
