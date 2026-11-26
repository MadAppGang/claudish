import { describe, expect, test } from "bun:test";
import { renderEntry } from "./transcript-lines.js";

/**
 * A Read result of a claudish turn file renders the file's content as one `task_file` line.
 * Turn files live in a `mkdtemp` directory: `launch-XXXXXX` under a pane root, or
 * `claudish-turns-XXXXXX` under the system temp directory for the interactive driver.
 */

const CONTENT = "Reply with exactly PEAR.";

function readResult(filePath: string): Record<string, unknown> {
  return {
    type: "user",
    isSidechain: false,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: `1\t${CONTENT}` }],
    },
    toolUseResult: {
      type: "text",
      file: { filePath, content: CONTENT, numLines: 1, startLine: 1, totalLines: 1 },
    },
  };
}

describe("a Read of a claudish turn file renders as task_file", () => {
  test("a pane's turn file (launch-XXXXXX)", () => {
    expect(renderEntry(readResult("/tmp/claudish-mux-501/launch-AbC123/turn-2.md"))).toEqual([
      { kind: "task_file", text: CONTENT },
    ]);
  });

  test("the interactive driver's turn file (claudish-turns-XXXXXX)", () => {
    expect(
      renderEntry(readResult("/var/folders/zz/abc/T/claudish-turns-Xy9Z01/turn-1.md"))
    ).toEqual([{ kind: "task_file", text: CONTENT }]);
  });

  test("a file of the same name in another directory is not a task file", () => {
    expect(renderEntry(readResult("/Users/me/project/claudish-turns/turn-1.md"))).toEqual([]);
    expect(renderEntry(readResult("/Users/me/project/notes/turn-1.md"))).toEqual([]);
  });
});
