import { describe, expect, test } from "bun:test";
import { LineBuffer } from "./line-buffer.js";

describe("LineBuffer", () => {
  test("splits lines across chunks and keeps the unterminated rest", () => {
    const b = new LineBuffer(1024);
    expect(b.push("a\nb")).toEqual({ lines: ["a"], overflow: false });
    expect(b.push("c\n\nd")).toEqual({ lines: ["bc", ""], overflow: false });
    expect(b.push("e\n")).toEqual({ lines: ["de"], overflow: false });
  });

  test("an unterminated rest past the cap in bytes overflows; lines ended before it are kept", () => {
    const b = new LineBuffer(4);
    // "é" is 2 bytes, so three of them (6 bytes) pass a 4-byte cap at 3 characters
    expect(b.push("ok\néé")).toEqual({ lines: ["ok"], overflow: false });
    expect(b.push("é")).toEqual({ lines: [], overflow: true });
    // after an overflow the buffer starts empty
    expect(b.push("x\n")).toEqual({ lines: ["x"], overflow: false });
  });

  test("one long unterminated line costs time linear in its length", () => {
    const chunk = "x".repeat(64 * 1024);
    const feed = (bytes: number): number => {
      const b = new LineBuffer(Number.MAX_SAFE_INTEGER);
      const t0 = performance.now();
      for (let sent = 0; sent < bytes; sent += chunk.length) b.push(chunk);
      return performance.now() - t0;
    };
    feed(1024 * 1024); // warm up
    const small = Math.max(feed(4 * 1024 * 1024), 1);
    const large = feed(16 * 1024 * 1024);
    // four times the input: about 4x when linear, about 16x when every chunk rescans the buffer
    expect(large / small).toBeLessThan(10);
  });
});
