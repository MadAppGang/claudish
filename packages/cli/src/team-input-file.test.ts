import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  judgeResponses,
  judgeSessionPath,
  parseJudgeVotes,
  readJudgeResponses,
  readSessionInput,
  readTeamInputFile,
  setupSession,
  startModels,
  validateSessionPath,
} from "./team-orchestrator.js";

describe("readTeamInputFile", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(process.cwd(), ".team-input-file-test-"));
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("rejects an absolute path outside the current directory", () => {
    const inputPath = resolve(process.cwd(), "..", "outside-team-input.txt");

    expect(() => readTeamInputFile(inputPath)).toThrow(
      `Input file must be within current directory: ${inputPath}`
    );
  });

  test("rejects relative traversal outside the current directory", () => {
    const inputPath = "../../etc/passwd";

    expect(() => readTeamInputFile(inputPath)).toThrow(
      `Input file must be within current directory: ${inputPath}`
    );
  });

  test("reports the resolved path when the file is missing", () => {
    const inputPath = relative(process.cwd(), join(fixtureDir, "missing.md"));

    expect(() => readTeamInputFile(inputPath)).toThrow(
      `Input file not found: ${resolve(inputPath)}`
    );
  });

  test("rejects an empty file", () => {
    const inputPath = join(fixtureDir, "empty.md");
    writeFileSync(inputPath, "", "utf-8");

    expect(() => readTeamInputFile(inputPath)).toThrow(`Input file is empty: ${inputPath}`);
  });

  test("rejects a whitespace-only file", () => {
    const inputPath = join(fixtureDir, "whitespace.md");
    writeFileSync(inputPath, " \t\n\r\n", "utf-8");

    expect(() => readTeamInputFile(inputPath)).toThrow(`Input file is empty: ${inputPath}`);
  });

  test("returns UTF-8 contents verbatim, including trailing newlines", () => {
    const inputPath = join(fixtureDir, "prompt.md");
    const contents = "Review café ☕️\n第二行 🚀\n\n";
    writeFileSync(inputPath, contents, "utf-8");

    expect(readTeamInputFile(inputPath)).toBe(contents);
  });
});

describe("readTeamInputFile — symlinks", () => {
  const originalCwd = process.cwd();
  let base: string;
  let work: string;
  let alias: string;
  let outside: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "team-input-link-")));
    work = join(base, "work");
    outside = join(base, "outside");
    mkdirSync(work);
    mkdirSync(outside);
    // Another spelling of the working directory, as macOS gives /var for /private/var.
    alias = join(base, "alias");
    symlinkSync(work, alias);
    process.chdir(work);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  test("accepts a file inside the working directory named through a symlinked spelling of it", () => {
    writeFileSync(join(work, "prompt.md"), "the task\n", "utf-8");

    expect(readTeamInputFile(join(alias, "prompt.md"))).toBe("the task\n");
  });

  test("refuses a symlink inside the working directory that points outside it", () => {
    writeFileSync(join(outside, "secret.md"), "not for the prompt\n", "utf-8");
    symlinkSync(join(outside, "secret.md"), join(work, "link.md"));

    expect(() => readTeamInputFile("link.md")).toThrow(
      "Input file must be within current directory: link.md"
    );
  });

  test("refuses a dangling symlink inside the working directory, naming it dangling", () => {
    symlinkSync(join(outside, "gone.md"), join(work, "dangling.md"));

    expect(() => readTeamInputFile("dangling.md")).toThrow(
      "Input file must be within current directory: dangling.md (a dangling symlink: its target does not exist)"
    );
  });

  test("names a dangling symlink when it is the session path", () => {
    symlinkSync(join(outside, "gone"), join(work, "session-link"));

    expect(() => validateSessionPath("session-link")).toThrow(
      "Session path must be within current directory: session-link (a dangling symlink: its target does not exist)"
    );
  });

  test("does not call a link that points outside dangling", () => {
    writeFileSync(join(outside, "secret.md"), "not for the prompt\n", "utf-8");
    symlinkSync(join(outside, "secret.md"), join(work, "link.md"));

    expect(() => readTeamInputFile("link.md")).not.toThrow(/dangling/);
    expect(() => readTeamInputFile("link.md")).toThrow(/within current directory/);
  });

  test("refuses a plain file outside the working directory", () => {
    const path = join(outside, "plain.md");
    writeFileSync(path, "outside\n", "utf-8");

    expect(() => readTeamInputFile(path)).toThrow(
      `Input file must be within current directory: ${path}`
    );
  });
});

describe("readSessionInput — a session folder's input.md", () => {
  const originalCwd = process.cwd();
  let base: string;
  let work: string;
  let outside: string;
  let session: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "team-session-input-")));
    work = join(base, "work");
    outside = join(base, "outside");
    session = join(work, "session");
    mkdirSync(session, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "not for the prompt\n", "utf-8");
    process.chdir(work);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });

  test("reads a plain input.md", () => {
    writeFileSync(join(session, "input.md"), "the task\n", "utf-8");

    expect(readSessionInput(session)).toBe("the task\n");
  });

  test("returns undefined when the folder has no input.md", () => {
    expect(readSessionInput(session)).toBeUndefined();
  });

  test("reads an input.md symlinked to a file inside the working directory", () => {
    writeFileSync(join(work, "brief.md"), "the brief\n", "utf-8");
    symlinkSync(join(work, "brief.md"), join(session, "input.md"));

    expect(readSessionInput(session)).toBe("the brief\n");
  });

  test("refuses an input.md symlinked to a file outside the working directory", () => {
    symlinkSync(join(outside, "secret.md"), join(session, "input.md"));

    expect(() => readSessionInput(session)).toThrow(
      `Session input.md must be within the current directory (${work}) or the session folder (${session}): ${join(session, "input.md")}`
    );
  });

  test("names only the working directory when the session folder itself resolves outside it", () => {
    const link = join(work, "linked-session");
    symlinkSync(outside, link);
    writeFileSync(join(outside, "input.md"), "outside prompt\n", "utf-8");

    expect(() => readSessionInput(link)).toThrow(
      `Session input.md must be within current directory: ${join(link, "input.md")}`
    );
  });

  test("setupSession on a session folder symlinked outside writes nothing outside", () => {
    const link = join(work, "linked-session");
    symlinkSync(outside, link);

    expect(() => setupSession(link, ["fake-model"], "new prompt\n")).toThrow(
      "Session input.md must be within current directory"
    );
    expect(readdirSync(outside).sort()).toEqual(["secret.md"]);
  });

  test("judgeSessionPath returns the session's judging folder", () => {
    expect(judgeSessionPath(session)).toBe(join(session, "judging"));
    mkdirSync(join(session, "judging"));
    expect(judgeSessionPath(session)).toBe(join(session, "judging"));
  });

  test("judgeResponses refuses a judging folder symlinked outside and writes nothing outside", async () => {
    writeFileSync(join(session, "input.md"), "the task\n", "utf-8");
    setupSession(session, ["model-a", "model-b"]);
    writeFileSync(join(session, "response-01.md"), "answer one\n", "utf-8");
    writeFileSync(join(session, "response-02.md"), "answer two\n", "utf-8");
    symlinkSync(outside, join(session, "judging"));

    await expect(judgeResponses(session, { judges: ["judge-model"] })).rejects.toThrow(
      `Judge folder must be within the current directory (${work}) or the session folder (${session}): ${join(session, "judging")}`
    );
    expect(readdirSync(outside).sort()).toEqual(["secret.md"]);
    expect(existsSync(join(session, "judge-prompt.md"))).toBe(false);
  });

  /**
   * A session with two answers whose judging folder already holds a manifest, so
   * judgeResponses stops at its setupSession and never starts a judge.
   */
  function judgedSession(): void {
    writeFileSync(join(session, "input.md"), "the task\n", "utf-8");
    setupSession(session, ["model-a", "model-b"]);
    writeFileSync(join(session, "response-01.md"), "answer one\n", "utf-8");
    writeFileSync(join(session, "response-02.md"), "answer two\n", "utf-8");
    mkdirSync(join(session, "judging"));
    writeFileSync(join(session, "judging", "manifest.json"), "{}", "utf-8");
  }

  test("judgeResponses refuses a judge-prompt.md symlinked outside and writes nothing outside", async () => {
    judgedSession();
    symlinkSync(join(outside, "secret.md"), join(session, "judge-prompt.md"));

    await expect(judgeResponses(session, { judges: ["judge-model"] })).rejects.toThrow(
      `Session judge-prompt.md must be within the current directory (${work}) or the session folder (${session}): ${join(session, "judge-prompt.md")}`
    );
    expect(readFileSync(join(outside, "secret.md"), "utf-8")).toBe("not for the prompt\n");
    expect(readdirSync(outside).sort()).toEqual(["secret.md"]);
  });

  test("judgeResponses refuses a dangling judge-prompt.md symlink and creates nothing outside", async () => {
    judgedSession();
    symlinkSync(join(outside, "planted.md"), join(session, "judge-prompt.md"));

    await expect(judgeResponses(session, { judges: ["judge-model"] })).rejects.toThrow(
      /dangling symlink/
    );
    expect(readdirSync(outside).sort()).toEqual(["secret.md"]);
  });

  test("a response file symlinked outside never reaches the judge prompt", async () => {
    judgedSession();
    symlinkSync(join(outside, "secret.md"), join(session, "response-03.md"));

    await expect(judgeResponses(session, { judges: ["judge-model"] })).rejects.toThrow(
      "Session already exists"
    );
    const prompt = readFileSync(join(session, "judge-prompt.md"), "utf-8");
    expect(prompt).toContain("answer one");
    expect(prompt).toContain("answer two");
    expect(prompt).not.toContain("not for the prompt");
    expect(prompt).not.toContain("Response 03");
  });

  test("readJudgeResponses names a response file outside as skipped", () => {
    judgedSession();
    symlinkSync(join(outside, "secret.md"), join(session, "response-03.md"));
    symlinkSync(join(outside, "gone.md"), join(session, "response-04.md"));

    expect(readJudgeResponses(session)).toEqual({
      responses: { "01": "answer one\n", "02": "answer two\n" },
      skipped: [
        "response-03.md (skipped: outside the working directory)",
        "response-04.md (skipped: a dangling symlink)",
      ],
    });
  });

  test("a response file outside does not count toward the two answers judging needs", async () => {
    judgedSession();
    rmSync(join(session, "response-02.md"));
    symlinkSync(join(outside, "secret.md"), join(session, "response-02.md"));

    await expect(judgeResponses(session, { judges: ["judge-model"] })).rejects.toThrow(
      "Need at least 2 responses to judge, found 1 (response-02.md (skipped: outside the working directory))"
    );
    expect(existsSync(join(session, "judge-prompt.md"))).toBe(false);
  });

  test("judging reads plain and in-tree symlinked responses unchanged", async () => {
    judgedSession();
    writeFileSync(join(work, "linked-answer.md"), "answer three\n", "utf-8");
    symlinkSync(join(work, "linked-answer.md"), join(session, "response-03.md"));

    expect(readJudgeResponses(session)).toEqual({
      responses: { "01": "answer one\n", "02": "answer two\n", "03": "answer three\n" },
      skipped: [],
    });
    await expect(judgeResponses(session, { judges: ["judge-model"] })).rejects.toThrow(
      "Session already exists"
    );
    const prompt = readFileSync(join(session, "judge-prompt.md"), "utf-8");
    for (const a of ["answer one", "answer two", "answer three"]) expect(prompt).toContain(a);
  });

  test("parseJudgeVotes does not read a vote file symlinked outside", () => {
    judgedSession();
    const judging = join(session, "judging");
    const vote = (summary: string) =>
      `\`\`\`vote\nRESPONSE: 01\nVERDICT: APPROVE\nCONFIDENCE: 7\nSUMMARY: ${summary}\nKEY_ISSUES: None\n\`\`\`\n`;
    writeFileSync(join(judging, "response-01.md"), vote("in tree"), "utf-8");
    writeFileSync(join(outside, "planted-vote.md"), vote("planted outside"), "utf-8");
    symlinkSync(join(outside, "planted-vote.md"), join(judging, "response-02.md"));
    symlinkSync(join(outside, "gone.md"), join(judging, "response-03.md"));

    const votes = parseJudgeVotes(judging, ["01", "02"]);
    expect(votes.map((v) => [v.judgeId, v.summary])).toEqual([["01", "in tree"]]);
  });

  test("a session folder outside the working directory keeps its own judging folder", () => {
    const own = join(base, "own-session");
    mkdirSync(own);
    expect(judgeSessionPath(own)).toBe(join(own, "judging"));
    setupSession(join(own, "judging"), ["judge-model"], "judge prompt\n");
    expect(readFileSync(join(own, "judging", "input.md"), "utf-8")).toBe("judge prompt\n");
  });

  test("a judging link out of a session folder outside the working directory is refused", () => {
    const own = join(base, "own-session");
    mkdirSync(own);
    symlinkSync(outside, join(own, "judging"));

    expect(() => judgeSessionPath(own)).toThrow(
      `Judge folder must be within the current directory (${work}) or the session folder (${own})`
    );
    expect(() => setupSession(join(own, "judging"), ["judge-model"], "judge prompt\n")).toThrow(
      "Session input.md must be within current directory"
    );
    expect(readdirSync(outside).sort()).toEqual(["secret.md"]);
  });

  test("refuses a dangling input.md symlink, naming it dangling", () => {
    symlinkSync(join(outside, "gone.md"), join(session, "input.md"));

    expect(() => readSessionInput(session)).toThrow(/dangling symlink/);
  });

  test("startModels refuses a session whose input.md points outside the working directory", async () => {
    writeFileSync(join(session, "input.md"), "placeholder\n", "utf-8");
    setupSession(session, ["fake-model"]);
    rmSync(join(session, "input.md"));
    symlinkSync(join(outside, "secret.md"), join(session, "input.md"));

    await expect(startModels(session, {})).rejects.toThrow(
      "Session input.md must be within the current directory ("
    );
  });

  test("setupSession refuses to write a prompt through an input.md that points outside", () => {
    symlinkSync(join(outside, "secret.md"), join(session, "input.md"));

    expect(() => setupSession(session, ["fake-model"], "new prompt\n")).toThrow(
      "Session input.md must be within the current directory ("
    );
    expect(readFileSync(join(outside, "secret.md"), "utf-8")).toBe("not for the prompt\n");
  });
});
