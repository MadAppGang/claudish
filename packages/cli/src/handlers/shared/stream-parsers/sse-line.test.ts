import { describe, expect, test } from "bun:test";
import { sseDataPayload } from "./sse-line.js";

describe("sseDataPayload", () => {
  test.each([
    ["data:{x}", "{x}"],
    ["data: {x}", "{x}"],
    ["data:  x", " x"],
    ["data:", ""],
    ["data: ", ""],
    ["data:\tx", "\tx"],
    ["event:response.created", null],
    ["id:1", null],
    [":comment", null],
    ["", null],
  ])("reads %j as %j", (line, expected) => {
    expect(sseDataPayload(line!)).toBe(expected);
  });
});
