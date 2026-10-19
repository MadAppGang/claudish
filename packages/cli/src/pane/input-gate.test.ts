import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkGateBinding, normaliseTranscriptPath } from "./gate-binding.js";
import {
  type GateDialogKind,
  type SendOutcome,
  classifySendReply,
  parseGateBinding,
  parseGateInput,
  readyWaitMs,
  sendBudgetMs,
  typedWriteCount,
} from "./input-gate.js";
import type { MagmuxReply } from "./magmux-client.js";

const DIALOG_KINDS = [
  "permission",
  "question",
  "plan",
  "select",
  "trust",
  "bypass",
  "api_key",
  "onboarding",
] as const;

// Verbatim format strings from magmux v0.16.0 inputgate_send.go:884 and :893.
// Substitute only the two fmt arguments, as magmux does on the socket.
const LEFT_BOX_MESSAGE =
  "pane %d: the input box showed the text and then emptied without magmux's Enter (%s); it is unknown whether another Enter submitted it, so check the conversation before sending it again; magmux pressed no Enter and did not retype it";
const CONVERSATION_MOVED_MESSAGE =
  "pane %d: the input box stayed empty after typing (%s); it is unknown whether another writer's Enter submitted it, so check the conversation before sending it again; magmux pressed no Enter";
const MISMATCH_MESSAGE =
  "pane %d: the input box does not hold what was typed (%s); Enter was not pressed, nothing was submitted, and the box may hold partial text";

function formatDetail(message: string, detail: string): string {
  return message.replace("%d", "0").replace("%s", detail);
}

function failure(
  code: string,
  error: string,
  fields: { reason?: string; typed?: boolean } = {}
): MagmuxReply {
  return { ok: false, code, error, ...fields };
}

function paneList(pane: Record<string, unknown>): unknown {
  return { panes: [{ pane: 0, ...pane }] };
}

const ACCEPTED: Extract<SendOutcome, { kind: "accepted" }> = {
  kind: "accepted",
  accept: "confirmed",
  evidence: "history",
  enterByMagmux: true,
  retyped: false,
  retypeCause: null,
  dismissed: [],
  waitedMs: 0,
  verified: null,
};

const IN_BOX: Extract<SendOutcome, { kind: "in_box" }> = {
  kind: "in_box",
  retyped: false,
  retypeCause: null,
  waitedMs: 0,
  verified: null,
};

describe("U1 classifySendReply", () => {
  test("maps confirmed and resent_enter with either evidence source", () => {
    for (const accept of ["confirmed", "resent_enter"] as const) {
      for (const evidence of ["history", "transcript"] as const) {
        expect(
          classifySendReply({
            ok: true,
            result: { accept, evidence, enter: true, waitedMs: 2400, verified: "exact" },
          })
        ).toEqual({ ...ACCEPTED, accept, evidence, waitedMs: 2400, verified: "exact" });
      }
    }
  });

  test("maps submitted_by_other without a magmux Enter for SUBMIT or TYPE", () => {
    // Both request classes have the same reply: accept, not enter, proves submission.
    for (const evidence of ["history", "transcript"] as const) {
      expect(
        classifySendReply({
          ok: true,
          result: {
            pane: 0,
            bytes: 13,
            keys: 0,
            enter: false,
            accept: "submitted_by_other",
            evidence,
          },
        })
      ).toEqual({ ...ACCEPTED, accept: "submitted_by_other", evidence, enterByMagmux: false });
    }
  });

  test("preserves accepted metadata and dismissed dialog order", () => {
    for (const verified of ["exact", "non_empty", "paste_token"]) {
      expect(
        classifySendReply({
          ok: true,
          result: {
            accept: "confirmed",
            evidence: "history",
            enter: true,
            waitedMs: 137,
            verified,
            dismissed: ["permission", "question", "plan"],
          },
        })
      ).toEqual({
        ...ACCEPTED,
        waitedMs: 137,
        verified,
        dismissed: ["permission", "question", "plan"],
      });
    }
  });

  test("maps in_box to TYPE completion without acceptance evidence", () => {
    expect(
      classifySendReply({
        ok: true,
        result: { accept: "in_box", enter: false, waitedMs: 1200, verified: "exact" },
      })
    ).toEqual({ ...IN_BOX, waitedMs: 1200, verified: "exact" });
  });

  test("defaults omitted optional success metadata", () => {
    expect(
      classifySendReply({
        ok: true,
        result: { accept: "confirmed", evidence: "history", enter: true },
      })
    ).toEqual(ACCEPTED);
    expect(classifySendReply({ ok: true, result: { accept: "in_box", enter: false } })).toEqual(
      IN_BOX
    );
  });

  test("preserves both retype causes on accepted and in_box replies", () => {
    for (const retypeCause of ["terminal_reset", "never_drawn"] as const) {
      expect(
        classifySendReply({
          ok: true,
          result: {
            accept: "confirmed",
            evidence: "history",
            enter: true,
            retyped: true,
            retypeCause,
          },
        })
      ).toEqual({ ...ACCEPTED, retyped: true, retypeCause });
      expect(
        classifySendReply({
          ok: true,
          result: { accept: "in_box", enter: false, retyped: true, retypeCause },
        })
      ).toEqual({ ...IN_BOX, retyped: true, retypeCause });
    }
  });

  test("uses unknown for an absent or future retype cause only when retyped", () => {
    for (const shape of [
      { accept: "confirmed", evidence: "history", enter: true },
      { accept: "in_box", enter: false },
    ]) {
      for (const cause of [{}, { retypeCause: "future_loss_signal" }]) {
        expect(
          classifySendReply({ ok: true, result: { ...shape, retyped: true, ...cause } })
        ).toMatchObject({ retyped: true, retypeCause: "unknown" });
      }
      for (const flag of [{}, { retyped: false }]) {
        expect(
          classifySendReply({
            ok: true,
            result: { ...shape, ...flag, retypeCause: "terminal_reset" },
          })
        ).toMatchObject({ retyped: false, retypeCause: null });
      }
    }
  });

  test("does not accept ungated, unknown-accept or evidence-free success replies", () => {
    for (const result of [
      { pane: 0, bytes: 13, keys: 0, enter: true },
      { accept: "future_accept", evidence: "history", enter: true },
      { accept: "confirmed", enter: true },
      { accept: "resent_enter", enter: true },
      { accept: "submitted_by_other", enter: false },
      { accept: "confirmed", evidence: "future_evidence", enter: true },
    ]) {
      expect(classifySendReply({ ok: true, result })).toMatchObject({
        kind: "unexpected",
        code: expect.any(String),
        error: expect.any(String),
      });
    }
  });

  test("maps every busy reason with omitted, false or true typed", () => {
    const reasons: Array<{ reason: string; dialog: GateDialogKind | null }> = [
      ...[
        "starting",
        "terminal_not_ready",
        "no_input_box",
        "typing_in_progress",
        "queue_full",
        "in_flight",
        "box_not_empty",
        "vim_mode",
      ].map((reason) => ({ reason, dialog: null })),
      ...DIALOG_KINDS.map((dialog) => ({ reason: `dialog:${dialog}`, dialog })),
    ];
    for (const { reason, dialog } of reasons) {
      for (const fields of [{}, { typed: false }, { typed: true }]) {
        expect(classifySendReply(failure("busy", "not ready", { reason, ...fields }))).toEqual({
          kind: "busy",
          reason,
          dialog,
          typed: fields.typed === true,
        });
      }
    }
  });

  test("keeps unknown busy reasons raw without inventing a dialog", () => {
    for (const reason of ["future_reason", "dialog:future_kind"]) {
      for (const typed of [false, true]) {
        expect(classifySendReply(failure("busy", "not ready", { reason, typed }))).toEqual({
          kind: "busy",
          reason,
          dialog: null,
          typed,
        });
      }
    }
  });

  test("maps every not_accepted reason and preserves typed and detail", () => {
    for (const reason of ["text_mismatch", "empty_box", "still_in_box", "unconfirmed"] as const) {
      for (const fields of [{}, { typed: false }, { typed: true }]) {
        expect(
          classifySendReply(failure("not_accepted", "pane 0: refusal detail", { reason, ...fields }))
        ).toEqual({
          kind: "not_accepted",
          reason,
          maybeSubmitted: false,
          typed: fields.typed === true,
          detail: "pane 0: refusal detail",
        });
      }
    }
  });

  test.each([
    ["leftBox", LEFT_BOX_MESSAGE],
    ["convMoved", CONVERSATION_MOVED_MESSAGE],
  ])("marks the verbatim %s text_mismatch message maybeSubmitted", (_name, message) => {
    const error = formatDetail(message, "it differs from what was sent");
    expect(
      classifySendReply(failure("not_accepted", error, { reason: "text_mismatch", typed: true }))
    ).toEqual({ kind: "not_accepted", reason: "text_mismatch", maybeSubmitted: true, typed: true, detail: error });
  });

  test("does not mark noLoss, windowCut or lostAgain mismatches maybeSubmitted", () => {
    // Exact detail tails from inputgate_send.go:864, :866 and :868, with fmt values filled in.
    for (const detail of [
      "it differs from what was sent; it stayed empty but the terminal showed no stdin reset, and the deadline left less than the 3s verify window that tells a silent drop from a slow draw, so the text was not retyped",
      "it differs from what was sent; it stayed empty but the terminal showed no stdin reset, and the box was not seen empty on every read for the whole 3s verify window, so the text was not retyped",
      "it differs from what was sent; the text was already retyped once (terminal reset) and the box stayed empty again, so it was not retyped a second time",
      "it differs from what was sent; the text was already retyped once (never drawn) and the box stayed empty again, so it was not retyped a second time",
    ]) {
      const error = formatDetail(MISMATCH_MESSAGE, detail);
      expect(
        classifySendReply(failure("not_accepted", error, { reason: "text_mismatch", typed: true }))
      ).toEqual({ kind: "not_accepted", reason: "text_mismatch", maybeSubmitted: false, typed: true, detail: error });
    }
  });

  test("requires the documented marker and text_mismatch reason for maybeSubmitted", () => {
    const ambiguous = formatDetail(LEFT_BOX_MESSAGE, "it differs from what was sent");
    for (const reason of ["empty_box", "still_in_box", "unconfirmed"]) {
      expect(classifySendReply(failure("not_accepted", ambiguous, { reason }))).toMatchObject({
        kind: "not_accepted",
        reason,
        maybeSubmitted: false,
      });
    }
    expect(
      classifySendReply(
        failure("not_accepted", "it is unknown whether another Enter submitted it", {
          reason: "text_mismatch",
        })
      )
    ).toMatchObject({ kind: "not_accepted", maybeSubmitted: false });
  });

  test("preserves bad_request error text", () => {
    expect(classifySendReply(failure("bad_request", "Enter must be the final key"))).toEqual({
      kind: "bad_request",
      error: "Enter must be the final key",
    });
  });

  test("maps caller timeout and client reply losses to reply_lost", () => {
    for (const code of ["timeout", "client_timeout", "client_lost"] as const) {
      expect(classifySendReply(failure(code, "reply unavailable"))).toEqual({
        kind: "reply_lost",
        code,
      });
    }
  });

  test("maps client_closed and no_client to unsent", () => {
    for (const code of ["client_closed", "no_client"] as const) {
      expect(classifySendReply(failure(code, "not written"))).toEqual({ kind: "unsent", code });
    }
  });

  test("maps dead or missing panes and preserves partial typing", () => {
    for (const code of ["pane_dead", "no_such_pane"] as const) {
      for (const fields of [{}, { typed: false }, { typed: true }]) {
        expect(classifySendReply(failure(code, "pane unavailable", fields))).toEqual({
          kind: "pane_gone",
          code,
          typed: fields.typed === true,
        });
      }
    }
  });

  test("keeps other README codes and unknown codes unexpected", () => {
    for (const code of ["unknown_verb", "unsupported", "internal", "pane_is_control", "too_small", "future_code"]) {
      expect(classifySendReply(failure(code, "upstream detail"))).toEqual({
        kind: "unexpected",
        code,
        error: "upstream detail",
      });
    }
  });
});

describe("U3 sendBudgetMs", () => {
  // Literal expected values from magmux's TestSendBudgetWorkedValues; no copied formula oracle.
  test.each([
    ["Go short submit", { readyTimeoutMs: 0, text: "", keys: 0, submit: true, typed: false }, 20780],
    ["Go 500 keys and a submit", { readyTimeoutMs: 0, text: "", keys: 500, submit: true, typed: false }, 42780],
    ["Go readyTimeoutMs 60000", { readyTimeoutMs: 60000, text: "", keys: 0, submit: true, typed: false }, 70780],
    ["Go TYPE with three writes", { readyTimeoutMs: 0, text: "a\nb", keys: 0, submit: false, typed: true }, 14840],
    ["13-character SUBMIT", { readyTimeoutMs: 10000, text: "run the tests", keys: 1, submit: true }, 20844],
    ["300-character file-template SUBMIT", { readyTimeoutMs: 10000, text: "x".repeat(300), keys: 1, submit: true }, 21024],
    ["512-character typed SUBMIT", { readyTimeoutMs: 10000, text: "x".repeat(512), keys: 1, submit: true }, 21144],
    ["command TYPE", { readyTimeoutMs: 10000, text: "/model haiku", keys: 0, submit: false }, 14800],
    ["command Enter SUBMIT", { readyTimeoutMs: 10000, text: "", keys: 1, submit: true }, 20824],
  ] as const)("matches %s exactly", (_name, shape, expected) => {
    expect(sendBudgetMs(shape)).toBe(expected);
  });

  test("defaults nonpositive readiness waits and clamps only above 60000", () => {
    for (const [ready, expected] of [[0, 10000], [-5, 10000], [1, 1], [2500, 2500], [60000, 60000], [600000, 60000]] as const) {
      expect(readyWaitMs(ready)).toBe(expected);
    }
  });

  test("uses the default or clamped readiness wait in the full budget", () => {
    for (const [readyTimeoutMs, expected] of [[0, 20844], [-5, 20844], [60000, 70844], [600000, 70844]] as const) {
      expect(sendBudgetMs({ readyTimeoutMs, text: "run the tests", keys: 1, submit: true })).toBe(expected);
    }
  });

  test("counts typed writes at rune and newline boundaries", () => {
    for (const [text, expected] of [
      ["", 0], ["hi", 1], ["a".repeat(32), 1], ["a".repeat(33), 2],
      ["a".repeat(512), 16], ["a\nb", 3], ["a\r\nb", 3], ["a\rb", 3],
      ["\n", 1], ["\r\n", 1], ["\r", 1], ["\n\n", 2],
      ["😀".repeat(32), 1], ["😀".repeat(33), 2],
    ] as const) {
      expect(typedWriteCount(text)).toBe(expected);
    }
  });

  test("uses rune and newline write counts in full TYPE budgets", () => {
    for (const [text, expected] of [["😀".repeat(33), 14820], ["a\nb", 14840], ["a\r\nb", 14840], ["a\rb", 14840]] as const) {
      expect(sendBudgetMs({ readyTimeoutMs: 10000, text, keys: 0, submit: false })).toBe(expected);
    }
  });
});

describe("U4 parseGateInput", () => {
  test("selects pane 0 by id rather than array position", () => {
    expect(
      parseGateInput({ panes: [
        { pane: 7, input: { ready: false, reason: "dialog:trust" } },
        { pane: 0, input: { ready: true } },
      ] }, 1234)
    ).toEqual({ ready: true, reason: null, dialog: null, detail: null, receivedAt: 1234 });
  });

  test("returns null when pane 0 or its input is absent", () => {
    for (const list of [undefined, null, {}, { panes: [] },
      { panes: [{ pane: 1, input: { ready: true } }] },
      paneList({}), paneList({ input: null }),
    ]) {
      expect(parseGateInput(list, 1234)).toBeNull();
    }
  });

  test("preserves the documented reason detail and caller timestamp", () => {
    expect(parseGateInput(paneList({ input: {
      ready: false, reason: "box_not_empty", detail: "the input box holds text",
    } }), 42)).toEqual({
      ready: false, reason: "box_not_empty", dialog: null,
      detail: "the input box holds text", receivedAt: 42,
    });
  });

  test("parses all eight dialog kinds", () => {
    for (const dialog of DIALOG_KINDS) {
      expect(parseGateInput(paneList({ input: { ready: false, reason: `dialog:${dialog}` } }), 10)).toEqual({
        ready: false, reason: `dialog:${dialog}`, dialog, detail: null, receivedAt: 10,
      });
    }
  });

  test("keeps future dialog and readiness reasons raw", () => {
    for (const reason of ["dialog:future_kind", "future_readiness_reason"]) {
      expect(parseGateInput(paneList({ input: { ready: false, reason, detail: "new detail" } }), 10)).toEqual({
        ready: false, reason, dialog: null, detail: "new detail", receivedAt: 10,
      });
    }
  });

  test("ignores undocumented boxHasText and dismissable fields", () => {
    expect(parseGateInput(paneList({ input: {
      ready: true, boxHasText: true, dismissable: ["permission"],
    } }), 10)).toEqual({ ready: true, reason: null, dialog: null, detail: null, receivedAt: 10 });
  });

  test("normalises omitted reason and detail and refreshes receivedAt", () => {
    const list = paneList({ input: { ready: false } });
    for (const now of [0, 100, 200]) {
      expect(parseGateInput(list, now)).toEqual({
        ready: false, reason: null, dialog: null, detail: null, receivedAt: now,
      });
    }
  });
});

describe("U4 R1.8 parseGateBinding", () => {
  const sessionId = "session-a";
  const transcriptPath = "/isolated/config/projects/project-a/session-a.jsonl";

  test("selects pane 0 binding by id rather than array position", () => {
    expect(parseGateBinding({ panes: [
      { pane: 2, bound: "mtime", sessionId: "other-session", transcriptPath: "/other/session.jsonl" },
      { pane: 0, bound: "named", sessionId, transcriptPath },
    ] })).toEqual({ bound: "named", boundRaw: "named", sessionId, transcriptPath });
  });

  test("preserves named prompt and mtime binding kinds without promoting them", () => {
    for (const bound of ["named", "prompt", "mtime"] as const) {
      expect(parseGateBinding(paneList({ bound, sessionId, transcriptPath }))).toEqual({
        bound, boundRaw: bound, sessionId, transcriptPath,
      });
    }
  });

  test("returns null when pane 0 is absent", () => {
    for (const list of [undefined, null, {}, { panes: [] }, { panes: [{ pane: 1, bound: "named", sessionId, transcriptPath }] }]) {
      expect(parseGateBinding(list)).toBeNull();
    }
  });

  test("reports missing binding metadata as unbound rather than named", () => {
    expect(parseGateBinding(paneList({}))).toEqual({
      bound: "unbound", boundRaw: null, sessionId: null, transcriptPath: null,
    });
    expect(parseGateBinding(paneList({ sessionId, transcriptPath }))).toEqual({
      bound: "unbound", boundRaw: null, sessionId, transcriptPath,
    });
  });

  test("keeps an unknown raw binding while classifying it unbound", () => {
    expect(parseGateBinding(paneList({ bound: "future_binding", sessionId, transcriptPath }))).toEqual({
      bound: "unbound", boundRaw: "future_binding", sessionId, transcriptPath,
    });
  });

  test("treats missing identity or path as unbound without borrowing another pane", () => {
    // R1.8: a missing binding field is unbound, even if bound itself says named.
    for (const [own, missing] of [
      [{ bound: "named", transcriptPath }, { sessionId: null, transcriptPath }],
      [{ bound: "named", sessionId }, { sessionId, transcriptPath: null }],
    ] as const) {
      expect(parseGateBinding({ panes: [
        { pane: 1, bound: "named", sessionId, transcriptPath }, { pane: 0, ...own },
      ] })).toEqual({ bound: "unbound", boundRaw: "named", ...missing });
    }
  });
});

describe("U11 checkGateBinding and normaliseTranscriptPath", () => {
  type ExpectedBinding = Parameters<typeof checkGateBinding>[1];
  const roots: string[] = [];
  const declaredPane = {
    controller: "claude-code",
    gateBasis: "declared",
    input: { ready: true },
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    }
  });

  function bindingSetup(createTranscript = true) {
    const root = mkdtempSync(join(tmpdir(), "cgb-"));
    roots.push(root);
    const configDir = join(root, "config");
    const projectDir = join(configDir, "projects", "project-a");
    mkdirSync(projectDir, { recursive: true });
    const expected: ExpectedBinding = {
      sessionUuid: "11111111-1111-4111-8111-111111111111",
      transcriptPath: join(projectDir, "11111111-1111-4111-8111-111111111111.jsonl"),
      magmuxVersion: "0.17.0",
    };
    if (createTranscript) writeFileSync(expected.transcriptPath, "");
    return { root, configDir, projectDir, expected };
  }

  function namedList(expected: ExpectedBinding, fields: Record<string, unknown> = {}): unknown {
    return paneList({
      ...declaredPane,
      bound: "named",
      sessionId: expected.sessionUuid,
      transcriptPath: expected.transcriptPath,
      ...fields,
    });
  }

  function expectUnbound(list: unknown, expected: ExpectedBinding): void {
    expect(checkGateBinding(list, expected)).toEqual({
      ok: false,
      detail: expect.stringContaining("input_gate_unbound"),
    });
  }

  test("accepts named binding with equal session id and existing normalised path", () => {
    const { projectDir, expected } = bindingSetup();
    const canonical = realpathSync(expected.transcriptPath);
    const paths = [
      expected.transcriptPath,
      `${projectDir}/../project-a/./${expected.sessionUuid}.jsonl`,
      relative(process.cwd(), expected.transcriptPath),
    ];
    for (const transcriptPath of paths) {
      expect(normaliseTranscriptPath(transcriptPath)).toBe(canonical);
      expect(checkGateBinding(namedList(expected, { transcriptPath }), expected)).toEqual({ ok: true });
    }
  });

  test("accepts named binding through a symlink-normalised existing transcript path", () => {
    const { root, projectDir, expected } = bindingSetup();
    const parentLink = join(root, "project-link");
    const fileLink = join(root, "transcript-link.jsonl");
    symlinkSync(projectDir, parentLink, "dir");
    symlinkSync(expected.transcriptPath, fileLink, "file");
    const canonical = realpathSync(expected.transcriptPath);
    for (const transcriptPath of [join(parentLink, `${expected.sessionUuid}.jsonl`), fileLink]) {
      expect(normaliseTranscriptPath(transcriptPath)).toBe(canonical);
      expect(checkGateBinding(namedList(expected, { transcriptPath }), expected)).toEqual({ ok: true });
      expect(checkGateBinding(namedList(expected), { ...expected, transcriptPath })).toEqual({ ok: true });
    }
  });

  test("normalises parent directory plus basename when the transcript does not exist yet", () => {
    const { root, projectDir, expected } = bindingSetup(false);
    const parentLink = join(root, "project-link");
    symlinkSync(projectDir, parentLink, "dir");
    // Also cover a missing project subdirectory: the deepest existing ancestor is the link target.
    for (const suffix of [
      `${expected.sessionUuid}.jsonl`,
      join("not-yet-created", "deeper", `${expected.sessionUuid}.jsonl`),
    ]) {
      const actualPath = join(parentLink, suffix);
      const expectedPath = join(projectDir, suffix);
      const canonical = join(realpathSync(projectDir), suffix);
      expect(existsSync(actualPath)).toBe(false);
      expect(existsSync(expectedPath)).toBe(false);
      expect(normaliseTranscriptPath(actualPath)).toBe(canonical);
      expect(normaliseTranscriptPath(expectedPath)).toBe(canonical);
      expect(checkGateBinding(
        namedList(expected, { transcriptPath: actualPath, transcriptSeen: false }),
        { ...expected, transcriptPath: expectedPath }
      )).toEqual({ ok: true });
      expect(checkGateBinding(
        namedList(expected, { transcriptPath: expectedPath, transcriptSeen: false }),
        { ...expected, transcriptPath: actualPath }
      )).toEqual({ ok: true });
      expect(existsSync(expectedPath)).toBe(false);
    }
  });

  test("rejects prompt binding even when session id and transcript path match", () => {
    const { expected } = bindingSetup();
    expectUnbound(namedList(expected, { bound: "prompt" }), expected);
  });

  test("rejects mtime binding even when session id and transcript path match", () => {
    const { expected } = bindingSetup();
    expectUnbound(namedList(expected, { bound: "mtime" }), expected);
  });

  test("rejects missing or unknown binding metadata instead of treating it as named", () => {
    const { expected } = bindingSetup();
    const sessionId = expected.sessionUuid;
    const transcriptPath = expected.transcriptPath;
    const bindings: Record<string, unknown>[] = [
      {},
      { sessionId, transcriptPath },
      { bound: "future_binding", sessionId, transcriptPath },
      { bound: "unbound", sessionId, transcriptPath },
      { bound: null, sessionId, transcriptPath },
      { bound: "named", transcriptPath },
      { bound: "named", sessionId },
      { bound: "named" },
    ];
    for (const binding of bindings) {
      expectUnbound({ panes: [
        { pane: 1, ...declaredPane, bound: "named", sessionId, transcriptPath },
        { pane: 0, ...declaredPane, ...binding },
      ] }, expected);
    }
  });

  test("rejects a different session id even when the transcript path matches", () => {
    const { expected } = bindingSetup();
    expectUnbound(namedList(expected, {
      sessionId: "22222222-2222-4222-8222-222222222222",
    }), expected);
  });

  test("rejects a different transcript path even when the session id or basename matches", () => {
    const { root, projectDir, expected } = bindingSetup();
    const otherProject = join(root, "other-project");
    mkdirSync(otherProject);
    const otherParentLink = join(root, "other-project-link");
    symlinkSync(otherProject, otherParentLink, "dir");
    const sameBasename = join(otherProject, `${expected.sessionUuid}.jsonl`);
    const differentBasename = join(projectDir, "other-session.jsonl");
    for (const transcriptPath of [sameBasename, differentBasename]) writeFileSync(transcriptPath, "");
    for (const transcriptPath of [
      sameBasename,
      differentBasename,
      join(otherParentLink, `${expected.sessionUuid}.jsonl`),
    ]) {
      expect(normaliseTranscriptPath(transcriptPath)).not.toBe(realpathSync(expected.transcriptPath));
      expectUnbound(namedList(expected, { transcriptPath }), expected);
    }
  });

  test("rejects a path under ~/.claude when CLAUDE_CONFIG_DIR points elsewhere", () => {
    const { root, configDir, expected } = bindingSetup();
    const home = join(root, "home");
    const defaultProject = join(home, ".claude", "projects", "project-a");
    mkdirSync(defaultProject, { recursive: true });
    const defaultPath = join(defaultProject, `${expected.sessionUuid}.jsonl`);
    writeFileSync(defaultPath, "");
    const priorHome = process.env.HOME;
    const priorConfig = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.HOME = home;
      process.env.CLAUDE_CONFIG_DIR = configDir;
      expect(normaliseTranscriptPath(defaultPath)).not.toBe(realpathSync(expected.transcriptPath));
      expectUnbound(namedList(expected, { transcriptPath: defaultPath }), expected);
      expect(checkGateBinding(namedList(expected), expected)).toEqual({ ok: true });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = priorConfig;
    }
  });
});
