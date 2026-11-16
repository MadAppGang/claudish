import { describe, expect, test } from "bun:test";
import { agyContents, agyLocalTime, agyToolResult, agyUserRequest } from "./antigravity-content.js";
import { AntigravityConversations, buildAntigravityEnvelope } from "./antigravity-envelope.js";

const T = "2026-11-17T00:05:02+11:00";

describe("the local time", () => {
  test("is written as year to second with the zone's offset", () => {
    const written = agyLocalTime(new Date(2026, 10, 17, 0, 5, 2));
    expect(written).toMatch(/^2026-11-17T00:05:02(Z|[+-]\d\d:\d\d)$/);
  });

  test("names the instant it was given", () => {
    const date = new Date(1794739596876);
    expect(new Date(agyLocalTime(date)).getTime()).toBe(Math.floor(date.getTime() / 1000) * 1000);
  });
});

describe("a user message", () => {
  test("is the recorded text of a later message", () => {
    expect(agyUserRequest("Now read a file.", T)).toBe(
      "<USER_REQUEST>\nNow read a file.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-17T00:05:02+11:00.\n</ADDITIONAL_METADATA>"
    );
  });

  test("names the model on a conversation's first message", () => {
    expect(agyUserRequest("hi", T, "Gemini 4 Argon (Medium)")).toBe(
      "<USER_REQUEST>\nhi\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-17T00:05:02+11:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Argon (Medium). No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\n</USER_SETTINGS_CHANGE>"
    );
  });
});

describe("the history's user entries", () => {
  const timeOf = () => T;

  test("the user's text is wrapped and the harness's text keeps its place", () => {
    const contents = [
      {
        role: "user",
        parts: [
          { text: "<system-reminder>\nrules\n</system-reminder>" },
          { text: "list the files" },
          { text: "<system-reminder>\nenvironment\n</system-reminder>" },
        ],
      },
    ];
    const before = structuredClone(contents);
    const out = agyContents(contents, { timeOf, modelDisplayName: "Model One" }) as any[];
    expect(out[0].parts).toEqual([
      { text: "<system-reminder>\nrules\n</system-reminder>" },
      { text: agyUserRequest("list the files", T, "Model One") },
      { text: "<system-reminder>\nenvironment\n</system-reminder>" },
    ]);
    expect(contents).toEqual(before);
  });

  test("two text parts of one message are one request, and only the first message names the model", () => {
    const out = agyContents(
      [
        { role: "user", parts: [{ text: "first" }] },
        { role: "model", parts: [{ text: "answer" }] },
        { role: "user", parts: [{ text: "second" }, { inlineData: {} }, { text: "third" }] },
      ],
      { timeOf, modelDisplayName: "Model One" }
    ) as any[];
    expect(out[1].parts).toEqual([{ text: "answer" }]);
    expect(out[2].parts).toEqual([
      { text: agyUserRequest("second\nthird", T) },
      { inlineData: {} },
    ]);
  });

  test("an entry that holds only the harness's text is left as it is", () => {
    const entry = { role: "user", parts: [{ text: "<system-reminder>\nx\n</system-reminder>" }] };
    expect(agyContents([entry], { timeOf })).toEqual([entry]);
  });

  test("each entry asks for its own time, by its place in the history", () => {
    const keys: string[] = [];
    agyContents(
      [
        { role: "user", parts: [{ text: "a" }] },
        { role: "model", parts: [{ text: "b" }] },
        { role: "user", parts: [{ text: "c" }] },
      ],
      {
        timeOf: (key) => {
          keys.push(key);
          return T;
        },
      }
    );
    expect(keys).toEqual(["user:0", "user:2"]);
  });
});

describe("a repeated entry keeps its time", () => {
  test("the second request of a conversation sends the first message with its first time", () => {
    const conversations = new AntigravityConversations(4, () => "id", "session");
    const first = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
    const second = {
      contents: [
        ...first.contents,
        { role: "model", parts: [{ text: "hi" }] },
        { role: "user", parts: [{ text: "again" }] },
      ],
    };
    const send = (inner: typeof first, now: number) =>
      (
        buildAntigravityEnvelope({
          inner,
          model: "gemini-4-argon-medium",
          projectId: "p",
          conversation: conversations.of(inner),
          sessionId: "s",
          now,
        }) as { request: { contents: Array<{ parts: Array<{ text: string }> }> } }
      ).request.contents;
    const early = 1794739596000;
    const late = early + 90_000;
    send(first, early);
    const contents = send(second, late);
    expect(contents[0].parts[0].text).toBe(agyUserRequest("hello", agyLocalTime(new Date(early))));
    expect(contents[2].parts[0].text).toBe(agyUserRequest("again", agyLocalTime(new Date(late))));
  });
});

describe("a tool result", () => {
  const header = `Created At: ${T}\nCompleted At: ${T}\n`;

  test("a command that succeeded", () => {
    expect(agyToolResult("run_command", "logs\nnote1.txt", {}, T)).toBe(
      `${header}Command exited with code 0.\n\nCommand output:\nlogs\nnote1.txt`
    );
  });

  test("a command that failed carries its exit code and not the harness's first line", () => {
    expect(
      agyToolResult(
        "run_command",
        "Exit code 1\nls: missing-file-xyz: No such file or directory",
        {},
        T
      )
    ).toBe(
      `${header}Command exited with code 1.\n\nCommand output:\nls: missing-file-xyz: No such file or directory`
    );
  });

  test("a whole file names its lines and its length", () => {
    expect(agyToolResult("read_file", "1\tNote 1.\n2\t", {}, T)).toBe(
      `${header}Showing lines 1-1 of 1\n1: Note 1.`
    );
  });

  test("a range of a file names its lines only: the file's length is not known", () => {
    expect(
      agyToolResult("read_file", "2\tline two\n3\tline three", { StartLine: 2, EndLine: 3 }, T)
    ).toBe(`${header}2: line two\n3: line three`);
  });

  test("a read that is not numbered lines keeps its text", () => {
    expect(agyToolResult("read_file", "File does not exist.", {}, T)).toBe(
      `${header}File does not exist.`
    );
  });

  test("a created file, and a write that says anything else", () => {
    expect(agyToolResult("write_file", "File created successfully at: /a/made.txt", {}, T)).toBe(
      `${header}Created file.`
    );
    expect(agyToolResult("write_file", "The file /a/made.txt has been updated.", {}, T)).toBe(
      `${header}The file /a/made.txt has been updated.`
    );
  });

  test("an edit keeps the harness's sentence under the header", () => {
    expect(agyToolResult("edit_file", "The file /a/made.txt has been updated.", {}, T)).toBe(
      `${header}The file /a/made.txt has been updated.`
    );
  });

  test("any other tool is not covered", () => {
    expect(agyToolResult("Skill", "done", {}, T)).toBeNull();
  });
});

describe("the history's tool results", () => {
  test("a result is worded by its tool, with the arguments of its own call", () => {
    const keys: string[] = [];
    const contents = [
      { role: "user", parts: [{ text: "<system-reminder>\nx\n</system-reminder>" }] },
      {
        role: "model",
        parts: [
          { functionCall: { id: "call_1", name: "read_file", args: { Path: "/a", StartLine: 2 } } },
          { functionCall: { id: "call_2", name: "Skill", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "call_1", name: "read_file", response: { output: "2\tb" } } },
          { functionResponse: { id: "call_2", name: "Skill", response: { output: "done" } } },
        ],
      },
    ];
    const before = structuredClone(contents);
    const out = agyContents(contents, {
      timeOf: (key) => {
        keys.push(key);
        return T;
      },
    }) as any[];
    expect(out[2].parts[0].functionResponse).toEqual({
      id: "call_1",
      name: "read_file",
      response: { output: `Created At: ${T}\nCompleted At: ${T}\n2: b` },
    });
    expect(out[2].parts[1]).toEqual(contents[2].parts[1]);
    expect(keys).toEqual(["result:call_1", "result:call_2"]);
    expect(contents).toEqual(before);
  });

  test("a result with no text output is left as it is", () => {
    const entry = {
      role: "user",
      parts: [{ functionResponse: { name: "run_command", response: { content: "x" } } }],
    };
    expect(agyContents([entry], { timeOf: () => T })).toEqual([entry]);
  });
});
