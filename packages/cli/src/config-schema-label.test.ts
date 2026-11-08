import { expect, test } from "bun:test";
import { ACCOUNT_LABEL_PATTERN } from "./auth/accounts/types.js";
import { SubscriptionAccountSchema } from "./config-schema.js";

// Parse a minimal saved row through the published schema; no real credential store.
const row = {
  id: "aaaaaaaaaaaa",
  label: "work",
  store: "file",
  addedAt: "2026-09-12T00:00:00.000Z",
  enabled: true,
  identity: { chatgptAccountId: "test-account", email: "jack+x@example.com", plan: "Pro" },
};

test("REQ-8 saved row schema accepts the widened label pattern", () => {
  for (const label of ["jack+x@example.com", "work", "my work", "a.b-c_d", "_", "a".repeat(64)]) {
    expect(SubscriptionAccountSchema.safeParse({ ...row, label }).success, label).toBe(true);
  }
});

test("REQ-8 saved row schema rejects forbidden, oversized and control-character labels", () => {
  const labels = [
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
    ...Array.from({ length: 32 }, (_, n) => "a" + String.fromCharCode(n)),
    "a\x7f",
  ];
  for (const label of labels) {
    expect(
      SubscriptionAccountSchema.safeParse({ ...row, label }).success,
      JSON.stringify(label)
    ).toBe(false);
  }
});

test("REQ-8 schema and exported pattern agree across all ASCII label characters", () => {
  // Include a baseline positive assertion so an invalid unrelated row field cannot
  // make every schema rejection look like successful label validation.
  expect(SubscriptionAccountSchema.safeParse(row).success).toBe(true);
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code);
    for (const label of [char, "a" + char, char + "a"]) {
      expect(
        SubscriptionAccountSchema.safeParse({ ...row, label }).success,
        JSON.stringify(label)
      ).toBe(ACCOUNT_LABEL_PATTERN.test(label));
    }
  }
});
