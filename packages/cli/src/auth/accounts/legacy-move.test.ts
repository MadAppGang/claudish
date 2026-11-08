import { describe, test } from "bun:test";
import { runIsolated } from "./legacy-move-harness.test-helper.js";

const TIMEOUT_MS = 30_000;
const integration = (name: string, scenario: string) =>
  test(name, () => runIsolated(scenario), TIMEOUT_MS);

describe("Codex legacy file → Keychain move (isolated children)", () => {
  integration(
    "REQ-1 LM1 enrolls synthesized default before publishing one verified Keychain account",
    "LM1"
  );
  integration(
    "REQ-2 LM2 preserves row id, metadata, order, disabled state and saved usage bytes",
    "LM2"
  );
  integration(
    "REQ-3 LM3 NEGATIVE CONTROL keeps file and config byte-identical when write fails",
    "LM3"
  );
  integration(
    "REQ-3 REQ-33 LM3 refuses oversized material before security and keeps both files byte-identical",
    "LM3-oversize"
  );
  integration(
    "REQ-4 LM4 NEGATIVE CONTROL keeps bytes and never retries an uncommitted ambiguous write",
    "LM4"
  );
  integration(
    "REQ-4 LM4 rejects read-back with matching lineage but a different writeId and keeps both files byte-identical",
    "LM4-wrong-proof"
  );
  integration("REQ-5 LM5 accepts a committed ambiguous write only after read-back proof", "LM5");
  integration("REQ-6 LM6 keeps both files unchanged when Keychain round-trip mismatches", "LM6");
  integration("REQ-7 LM7 refuses a locked destination without attempting a write", "LM7");

  for (const variant of ["torn", "empty", "no-pair"] as const) {
    integration(
      "REQ-8 LM8 returns file-unreadable without security calls for " + variant,
      "LM8-" + variant
    );
  }
  for (const variant of ["file-denied", "parent-denied"] as const) {
    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "REQ-8 LM8 returns file-unreadable without security calls for " + variant,
      () => runIsolated("LM8-" + variant),
      TIMEOUT_MS
    );
  }

  integration(
    "REQ-9 LM9 resumes a verified unpublished item under the enrolled id without another write",
    "LM9-same"
  );
  integration(
    "REQ-9 LM9 overwrites unpublished crash debris when the authoritative file rotated",
    "LM9-rotated"
  );
  integration(
    "REQ-9 LM9 overwrites unpublished debris when only generation advanced with the same fingerprint",
    "LM9-generation"
  );
  integration(
    "REQ-10 LM10 deletes a post-publication leftover without changing config bytes",
    "LM10"
  );
  integration("REQ-11 LM11 keeps an older build's rewritten file at compare-and-delete", "LM11");
  integration(
    "REQ-12 LM12 complementary invalid-config publication failure keeps file and resumes",
    "LM12-invalid-config"
  );
  integration(
    "REQ-12 LM12 defers publication after 250 ms behind a real config transaction and preserves the concurrent writer on retry",
    "LM12-busy-lock"
  );

  integration(
    "REQ-13 LM13 GATE NEGATIVE TEST cannot write while a peer refresh holds legacy-codex.lock; copies rotation",
    "LM13"
  );
  integration(
    "REQ-14 LM14 serializes two processes into one moved, one already-moved and one Keychain write",
    "LM14"
  );
  integration(
    "REQ-15 LM15 leaves an all-Keychain configuration untouched without security calls",
    "LM15"
  );
  integration("REQ-16 LM16 does not move or call security on Linux", "LM16-linux");
  integration(
    "REQ-16 LM16 does not move or call security when Keychain is explicitly disabled on Darwin",
    "LM16-disabled"
  );
  integration("REQ-17 LM17 does not consume shared material from an alternate config", "LM17");
  integration(
    "REQ-18 LM18 keeps both registry presence projections true at every supplied move boundary",
    "LM18"
  );
  integration(
    "REQ-19 LM19 copies lineage and open journal verbatim, makes a new writeId and preserves reauth evidence bytes",
    "LM19"
  );
});

describe("move entry points and concurrent legacy readers", () => {
  integration(
    "REQ-27 starts one nonblocking background flight while the facade signs; commands bypass cooldown",
    "background"
  );
  integration(
    "REQ-27 retries deferred background work at exactly ten minutes, not one millisecond sooner",
    "background-boundary"
  );
  for (const verb of ["enable", "disable", "rename"] as const) {
    integration(
      "REQ-28 account " + verb + " moves first without stale legacy-enrolment guidance",
      "verb-" + verb
    );
  }
  for (const verb of ["add", "login"] as const) {
    integration(
      "REQ-28 account " + verb + " refuses a deferred move before PKCE",
      "verb-deferred-" + verb
    );
  }
  integration("REQ-28 registry reads never enroll or move a synthesized legacy login", "read-only");
  integration(
    "REQ-29 a facade initialized before the move reports a transient local error with no upstream status",
    "facade-moved"
  );
  integration(
    "REQ-29 a genuinely logged-out facade retains the terminal refresh error",
    "facade-logout"
  );
  integration(
    "REQ-31 display recognizes a Keychain account without a file or Keychain value read",
    "display"
  );
  integration(
    "REQ-32 deferral messages name the kept file and appropriate retry, unlock or repair action",
    "messages"
  );
  integration(
    "REQ-32 target-changed refuses publication and preserves a concurrent config writer's new identity",
    "target-changed"
  );
});
