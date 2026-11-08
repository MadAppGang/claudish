import { describe, expect, test } from "bun:test";
import { redact, redactString } from "./redact-transcript-fixture.js";

describe("transcript fixture redaction", () => {
  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("a task-notification keeps its task-id while redacting its body", () => {
    const redacted = redactString(
      "prompt",
      "<task-notification>\n<task-id>ab9d8b94e58c3540a</task-id>\n<status>completed</status>secret text</task-notification>"
    );
    expect(redacted).toContain("<task-id>ab9d8b94e58c3540a</task-id>");
    expect(redacted).not.toContain("secret text");
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("a task-notification without a task-id keeps the id-less redacted form", () => {
    expect(redactString("prompt", "<task-notification>secret text</task-notification>")).toBe(
      "<task-notification>redacted</task-notification>"
    );
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("a backgroundTaskId is preserved verbatim", () => {
    expect(redact({ backgroundTaskId: "b9s8u1vld" })).toEqual({
      backgroundTaskId: "b9s8u1vld",
    });
  });

  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  test("a quoted task-notification does not keep its task-id", () => {
    const redacted = redactString(
      "prompt",
      '<agent-message from="x">I saw <task-notification><task-id>ae0168d27fc09161c</task-id> earlier</agent-message>'
    );
    expect(redacted).not.toContain("<task-id>");
    expect(redacted).not.toContain("ae0168d27fc09161c");
  });
});
