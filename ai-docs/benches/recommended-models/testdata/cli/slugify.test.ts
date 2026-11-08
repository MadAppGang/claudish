import { expect, test } from "bun:test";
import { slugify } from "./slugify";

test("slugify", () => {
  expect(slugify("Hello World")).toBe("hello-world");
  expect(slugify("Hello, World!")).toBe("hello-world");
  expect(slugify("  Many   spaces  here ")).toBe("many-spaces-here");
  expect(slugify("Version 2.0 -- Release")).toBe("version-2-0-release");
});
