import { describe, test } from "bun:test";
import { runIsolated } from "./legacy-move-harness.test-helper.js";

describe("claudish login codex Keychain routing (public management entry)", () => {
  test(
    "REQ-20 L1 fresh PKCE login creates one default Keychain row, no file and no owned-accounts notice",
    () => runIsolated("L1"),
    30_000
  );
  test(
    "REQ-21 L2 legacy-only PKCE login moves first then re-logs the same row at generation+1",
    () => runIsolated("L2"),
    30_000
  );

  test(
    "REQ-22 L3 refuses two configured accounts before browser or persistence",
    () => runIsolated("L3"),
    30_000
  );

  test(
    "REQ-23 L4 MTL-371 alternate-config PKCE login writes only its own Keychain item/row; shared file and default config hashes unchanged",
    () => runIsolated("L4"),
    30_000
  );

  test(
    "REQ-24 L5 refuses a deferred move before browser and explains Keychain unlock and file kept",
    () => runIsolated("L5"),
    30_000
  );

  test(
    "REQ-25 L6 routing predicate keeps the disabled-Keychain login on its legacy path",
    () => runIsolated("L6-routing"),
    30_000
  );
  test(
    "REQ-25 L6 successful disabled-Keychain PKCE login writes the legacy file, not a row",
    () => runIsolated("L6-success"),
    30_000
  );
  test(
    "REQ-26 L7 different-identity PKCE login refuses without persistence and names both add and account-remove/login remedies",
    () => runIsolated("L7"),
    30_000
  );

  // L8/logout was dropped explicitly. Do not extend the ticket's scope.
});
