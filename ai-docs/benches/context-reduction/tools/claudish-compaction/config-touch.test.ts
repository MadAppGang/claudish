import { describe, expect, test } from "bun:test";
import { countConfigTouches, touchesConfig } from "./config-touch";

const home = "/var/folders/ch/x/T/madbench-123/home";
const work = "/private/var/folders/ch/x/T/madbench-123/work";

const bash = (command: string) => touchesConfig("Bash", { command }, home);

describe("file tools touch the config only through their target path", () => {
  test("a Read of the HOME config counts", () => {
    expect(touchesConfig("Read", { file_path: `${home}/.claudish/config.json` }, home)).toBe(true);
  });

  test("the /private spelling of the sandbox home counts", () => {
    expect(
      touchesConfig("Read", { file_path: `/private${home}/.claudish/config.json` }, home)
    ).toBe(true);
  });

  test("another trial's sandbox home counts", () => {
    expect(
      touchesConfig(
        "Read",
        { file_path: "/private/var/folders/ch/x/T/madbench-999/home/.claudish/config.json" },
        home
      )
    ).toBe(true);
  });

  test("a Write and an Edit of the HOME config count", () => {
    expect(
      touchesConfig("Write", { file_path: `${home}/.claudish/config.json`, content: "{}" }, home)
    ).toBe(true);
    expect(
      touchesConfig(
        "Edit",
        { file_path: "~/.claudish/config.json", old_string: "a", new_string: "b" },
        home
      )
    ).toBe(true);
  });

  test("a Grep over the HOME config counts", () => {
    expect(
      touchesConfig("Grep", { pattern: "model", path: `${home}/.claudish/config.json` }, home)
    ).toBe(true);
  });

  test("a Write whose content names the config does not count", () => {
    expect(
      touchesConfig(
        "Write",
        {
          file_path: `${work}/packages/cli/src/x.test.ts`,
          content: "// the real ~/.claudish/config.json",
        },
        home
      )
    ).toBe(false);
  });

  test("an Edit of a doc that names the config does not count", () => {
    expect(
      touchesConfig(
        "Edit",
        {
          file_path: `${work}/packages/cli/CONTEXT-WINDOW.md`,
          old_string: "x",
          new_string: "`~/.claudish/config.json` or CLAUDISH_CONFIG",
        },
        home
      )
    ).toBe(false);
  });

  test("a config file inside the workspace is not the HOME config", () => {
    expect(touchesConfig("Read", { file_path: `${work}/.claudish/config.json` }, home)).toBe(false);
  });
});

describe("Bash commands touch the config when the shell resolves the path to HOME", () => {
  test("cat ~/.claudish/config.json counts", () => {
    expect(bash("cat ~/.claudish/config.json")).toBe(true);
  });

  test("$HOME, ${HOME} and double quotes count", () => {
    expect(bash('cp "$HOME/.claudish/config.json" /tmp/x')).toBe(true);
    expect(bash("jq . ${HOME}/.claudish/config.json")).toBe(true);
  });

  test("ls, a write redirect and a later command in a chain count", () => {
    expect(bash("ls -la ~/.claudish/config.json")).toBe(true);
    expect(bash("echo '{}' > ~/.claudish/config.json")).toBe(true);
    expect(bash("cd /tmp && cat ~/.claudish/config.json | head")).toBe(true);
  });

  test("the literal sandbox home path counts, in either spelling", () => {
    expect(bash(`cat ${home}/.claudish/config.json`)).toBe(true);
    expect(bash(`cat "/private${home}/.claudish/config.json"`)).toBe(true);
  });

  test("a quoted tilde is a search string, not a path", () => {
    expect(bash('grep -rn "~/.claudish/config.json" src')).toBe(false);
    expect(bash("grep -rn '~/.claudish/config.json' src")).toBe(false);
  });

  test("$HOME inside single quotes is not expanded", () => {
    expect(bash("grep -n '$HOME/.claudish/config.json' docs/x.md")).toBe(false);
  });

  test("CLAUDISH_CONFIG alone does not count", () => {
    expect(bash('grep -n "CLAUDISH_CONFIG" src/profile-config.ts')).toBe(false);
  });

  test("a relative or workspace .claudish path does not count", () => {
    expect(bash("cat .claudish/config.json")).toBe(false);
    expect(bash(`cat ${work}/.claudish/config.json`)).toBe(false);
  });
});

describe("countConfigTouches over transcript lines", () => {
  const line = (name: string, input: unknown) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t", name, input }] },
    });

  test("counts each touching tool call once and ignores the rest", () => {
    const lines = [
      line("Read", { file_path: `${home}/.claudish/config.json` }),
      line("Bash", { command: "cat ~/.claudish/config.json" }),
      line("Bash", { command: 'grep -n "CLAUDISH_CONFIG" src/profile-config.ts' }),
      line("Write", { file_path: `${work}/a.md`, content: "~/.claudish/config.json" }),
      "not json",
      "",
    ];
    expect(countConfigTouches(lines, home)).toBe(2);
  });
});
