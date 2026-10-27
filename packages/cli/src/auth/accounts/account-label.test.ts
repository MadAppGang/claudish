import { expect, test } from "bun:test";
import {
  ACCOUNT_LABEL_MAX,
  ACCOUNT_LABEL_PATTERN,
  ACCOUNT_LABEL_RULE,
  cleanPlan,
  deriveAccountLabel,
  emailMatches,
  labelTaken,
  shellWord,
} from "./account-label.js";
import { ACCOUNT_LABEL_PATTERN as publicPattern } from "./types.js";

const valid = ["jack+x@example.com", "work", "my work", "a.b-c_d", "_", "0", "a".repeat(64)];
const invalid = [
  "",
  "a;b",
  "a(b)",
  "-a",
  ".a",
  "+a",
  "@a",
  " a",
  "a".repeat(65),
  "é",
  "a/b",
  "a'b",
];

test("REQ-3 pattern and public re-export enforce the ASCII 1–64 character rule", () => {
  expect(ACCOUNT_LABEL_MAX).toBe(64);
  expect(ACCOUNT_LABEL_RULE.length).toBeGreaterThan(0);
  for (const label of valid) {
    expect(ACCOUNT_LABEL_PATTERN.test(label), label).toBe(true);
    expect(publicPattern.test(label), label).toBe(true);
  }
  for (const label of [
    ...invalid,
    ...Array.from({ length: 32 }, (_, n) => "a" + String.fromCharCode(n)),
    "a\x7f",
    "a\n",
  ]) {
    expect(ACCOUNT_LABEL_PATTERN.test(label), JSON.stringify(label)).toBe(false);
    expect(publicPattern.test(label), JSON.stringify(label)).toBe(false);
  }
});

test("REQ-2 plan cleaning removes punctuation and caps the cleaned plan at 16", () => {
  expect(cleanPlan("Pro; rm")).toBe("prorm");
  expect(cleanPlan("TEAM-42")).toBe("team42");
  expect(cleanPlan("A".repeat(20))).toBe("a".repeat(16));
  for (const plan of [undefined, "", " ;() "]) expect(cleanPlan(plan)).toBeUndefined();
});

test("REQ-1 REQ-2 email defaults are normalized and use the ordered case-insensitive clash ladder", () => {
  const input = { email: " Jack+X@Example.COM ", plan: "Pro; rm" };
  const base = "jack+x@example.com";
  expect(deriveAccountLabel({ ...input, taken: [] })).toBe(base);
  expect(deriveAccountLabel({ ...input, taken: [base.toUpperCase()] })).toBe(base + "-prorm");
  expect(deriveAccountLabel({ ...input, taken: [base, base + "-prorm"] })).toBe(base + "-prorm-2");
  expect(deriveAccountLabel({ ...input, taken: [base, base + "-prorm", base + "-prorm-2"] })).toBe(
    base + "-prorm-3"
  );
  expect(deriveAccountLabel({ email: base, taken: [base] })).toBe(base + "-2");
  expect(deriveAccountLabel({ email: base, plan: "!!!", taken: [base, base + "-2"] })).toBe(
    base + "-3"
  );
  expect(deriveAccountLabel({ email: "@+.-A B'@X.COM", taken: [] })).toBe("a_b_@x.com");
});

test("REQ-6 no email falls back to a filtered short account id and still resolves clashes", () => {
  expect(deriveAccountLabel({ chatgptAccountId: "ABC!D123456789", taken: [] })).toBe("abcd1234");
  expect(
    deriveAccountLabel({
      email: "   ",
      chatgptAccountId: "ABCDEFGHrest",
      plan: "Plus",
      taken: ["abcdefgh"],
    })
  ).toBe("abcdefgh-plus");
  expect(() => deriveAccountLabel({ taken: [] })).toThrow(/--label/);
});

test("REQ-2 REQ-3 suffixes fit within 64 and trim punctuation off the cut base", () => {
  const email = "a".repeat(59) + ".@" + "b".repeat(10);
  const first = deriveAccountLabel({ email, taken: [] });
  expect(first).toHaveLength(64);
  const second = deriveAccountLabel({ email, plan: "Pro", taken: [first] });
  expect(second).toBe("a".repeat(59) + "-pro");
  const third = deriveAccountLabel({ email, plan: "Pro", taken: [first, second] });
  expect(third).toBe("a".repeat(58) + "-pro-2");
  for (const label of [first, second, third]) expect(ACCOUNT_LABEL_PATTERN.test(label)).toBe(true);
});

test("REQ-2 exhausting suffixes through 999 throws instead of reusing a label", () => {
  const taken = ["x", "x-pro", ...Array.from({ length: 998 }, (_, n) => "x-pro-" + (n + 2))];
  expect(() => deriveAccountLabel({ email: "x", plan: "pro", taken })).toThrow();
});

test("REQ-4 comparisons are exact ignoring case, not partial matches", () => {
  expect(labelTaken(new Set(["Work"]), "work")).toBe(true);
  expect(labelTaken(["Work"], "wor")).toBe(false);
  expect(emailMatches("Jack@Example.com", "JACK@example.COM")).toBe(true);
  expect(emailMatches("jack@example.com", "jack")).toBe(false);
  expect(emailMatches(undefined, "jack@example.com")).toBe(false);
  expect(emailMatches("jack@example.com", " jack@example.com")).toBe(false);
});

test("REQ-7 shell words remain bare only when safe", () => {
  expect(shellWord("jack+x@example.com")).toBe("jack+x@example.com");
  expect(shellWord("a.b-c_d")).toBe("a.b-c_d");
  expect(shellWord("my work")).toBe("'my work'");
  expect(shellWord("")).toBe("''");
});
