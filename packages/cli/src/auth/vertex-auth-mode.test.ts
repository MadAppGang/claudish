import { describe, expect, test } from "bun:test";
import { selectVertexAuthMode } from "./vertex-auth.js";

describe("Vertex account selection", () => {
  test("a selected project takes precedence over an Express key", () => {
    expect(selectVertexAuthMode({ project: "chosen-project", expressKey: "configured-key" })).toBe(
      "project"
    );
  });

  test("the Express key is selected only without a project", () => {
    expect(selectVertexAuthMode({ expressKey: "configured-key" })).toBe("express");
  });

  test("neither mode is available without configuration", () => {
    expect(selectVertexAuthMode({})).toBeNull();
  });
});
