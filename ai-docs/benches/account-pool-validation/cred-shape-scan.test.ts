import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BASE64_BLOCK_OVERLAP,
  BASE64_MAX_RUN,
  SCAN_CHUNK_BYTES,
  SCAN_OVERLAP_BYTES,
  base64Blocks,
  redactCredentialShapes,
  scanCredentialShapes,
  writeScanned,
} from "./cred-shape-scan.ts";
import { FAKE_SECRETS } from "./e20-gate.ts";
import { scanSecrets } from "./e20.ts";
import { CANARY_KEY, realCredentialFindings } from "./harness.ts";

// Finding (2026-11-02): the leak scan found only secrets the bench created. A REAL credential
// entering from outside (run 14: a real 1821-char JWT bearer in fake.jsonl) was invisible.
// Every credential-shaped value below is BUILT at run time: no token literal in the source.

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
/** Deterministic bytes: a sha256 chain from `seed`. */
function bytes(seed: string, n: number): Buffer {
  const out: Buffer[] = [];
  let h = Buffer.from(seed);
  while (Buffer.concat(out).length < n) {
    h = createHash("sha256").update(h).digest();
    out.push(h);
  }
  return Buffer.concat(out).subarray(0, n);
}
/** A JWT-shaped bearer (header.payload.signature, base64url); `claimBytes` sizes the payload. */
function realLookingJwt(seed = "jwt", claimBytes = 24): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: seed }));
  const payload = b64url(
    JSON.stringify({
      sub: `user-${b64url(bytes(seed, claimBytes))}`,
      aud: ["https://example.test"],
      exp: 1,
    })
  );
  return `${header}.${payload}.${b64url(bytes(`${seed}-sig`, 256))}`;
}
const realLookingSk = () => `sk-proj-${b64url(bytes("sk", 30))}`;

const roots: string[] = [];
function tree(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shape-scan-")));
  roots.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** No 6-character run of `value` appears in `text` (the printed message holds no part of it). */
function holdsNoPartOf(text: string, value: string): boolean {
  for (let i = 0; i + 6 <= value.length; i++)
    if (text.includes(value.slice(i, i + 6))) return false;
  return true;
}

describe("a real credential entering from outside is caught by shape", () => {
  test("a real-looking JWT in fake.jsonl (an evidence file) fails the run", () => {
    const jwt = realLookingJwt();
    expect(jwt.length).toBeGreaterThan(100);
    const line = `{"seq":1,"bearer":"Bearer ${jwt}"}\n`;
    const dir = tree({ "fake.jsonl": line });
    const found = realCredentialFindings(dir, []);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("fake.jsonl @");
    expect(found[0]).toContain(`@${line.indexOf("eyJ")}:`);
    expect(found[0]).toContain(`${jwt.length} chars`);
  });

  test("request bodies and the pre-flight are scanned too", () => {
    const dir = tree({
      "bodies/001-main.json": `{"k":"${realLookingJwt("a")}"}`,
      "preflight/fake.jsonl": `Bearer ${realLookingJwt("b")}`,
    });
    const files = realCredentialFindings(dir, []).map((f) => f.split(" @")[0]);
    expect(files).toEqual(["bodies/001-main.json", "preflight/fake.jsonl"]);
  });

  test("an sk- key of at least 20 characters in stderr is caught", () => {
    const dir = tree({ "serve-1-stderr.txt": `auth ${realLookingSk()} rejected` });
    expect(realCredentialFindings(dir, [])[0]).toContain("sk-key-shaped credential");
  });

  test("a JWT split across a window boundary is found once, at its true offset", () => {
    const jwt = realLookingJwt("w");
    const text = `${"x".repeat(990)} ${jwt} ${"y".repeat(5000)}`;
    const dir = tree({ "stdout.txt": text });
    const found = scanCredentialShapes(dir, [], { chunkBytes: 1000, overlapBytes: 4096 });
    expect(found.findings.map((f) => f.offset)).toEqual([991]);
  });
});

describe("the bench's own values are not findings", () => {
  test("seeded, issued, canary and E20 fake values, and short eyJ strings, pass", () => {
    const dir = tree({
      "fake.jsonl": "Bearer access-A refresh-A at-rotated-3 rt-rotated-3 access-legacy",
      "canary.jsonl": `{"authorization":"Bearer ${CANARY_KEY}"}`,
      "fake-requests.json": [...FAKE_SECRETS].join(" "),
      "stdout.txt": "eyJhbGciOiJIUzI1NiJ9.e30.abc task-force-sk-is-not-a-key",
    });
    expect(realCredentialFindings(dir, ["access-A", "refresh-A"])).toEqual([]);
  });

  test("a JWT the bench itself registered as known is not a finding", () => {
    const jwt = realLookingJwt("known");
    const dir = tree({ "fake.jsonl": jwt });
    expect(realCredentialFindings(dir, [jwt])).toEqual([]);
    expect(realCredentialFindings(dir, []).length).toBe(1);
  });
});

describe("copied product bundles are excluded", () => {
  test.each(["mutant-trees/V1/packages/cli/dist", "mutant-tree/dist", "mutants/V16-remap/dist"])(
    "a JWT inside %s is not scanned",
    (bundle) => {
      const dir = tree({ [`${bundle}/index.js`]: `const t="${realLookingJwt()}";` });
      expect(realCredentialFindings(dir, [])).toEqual([]);
      expect(scanCredentialShapes(dir, []).findings).toEqual([]);
    }
  );

  test("a mutant run's own directory is left to that run (harness), E20's mutant-raw is scanned", () => {
    const jwt = realLookingJwt();
    const dir = tree({
      "mutant-V1-x/fake.jsonl": jwt,
      "mutant-raw/V16-remap/fake-requests.json": jwt,
    });
    expect(realCredentialFindings(dir, []).map((f) => f.split(" @")[0])).toEqual([]);
    expect(scanSecrets(dir).violations.join("|")).toContain(
      "mutant-raw/V16-remap/fake-requests.json @"
    );
  });
});

// Review round 6 (C1): GPT's in-memory reproduction found 0 findings for an escaped, base64 or
// UTF-16LE JWT; Gemini named rt_ tokens, truncated JWTs and opaque refresh-token fields.
describe("encoded and truncated credentials are caught (review round 6)", () => {
  const jwt = realLookingJwt("enc");
  const kinds = (dir: string) =>
    scanCredentialShapes(dir, []).findings.map(
      (f) => `${f.kind}${f.encoding ? `/${f.encoding}` : ""}`
    );

  test("JWT dots written as JSON \\u002e escapes", () => {
    const dir = tree({ "fake.jsonl": `{"bearer":"Bearer ${jwt.replaceAll(".", "\\u002e")}"}` });
    expect(kinds(dir)).toEqual(["jwt/json-escaped"]);
  });

  test("a JWT inside a base64 body field", () => {
    const body = Buffer.from(JSON.stringify({ authorization: `Bearer ${jwt}` })).toString("base64");
    const dir = tree({ "bodies/001-main.json": `{"bodyBase64":"${body}"}` });
    expect(kinds(dir)).toContain("jwt/base64");
  });

  test("a JWT written as UTF-16LE text", () => {
    const dir = tree({});
    writeFileSync(join(dir, "stderr.txt"), Buffer.from(`token ${jwt} rejected`, "utf16le"));
    expect(kinds(dir)).toEqual(["jwt/utf16le"]);
  });

  test("a JWT cut to 200 characters (one dot left) is a jwt-prefix", () => {
    // A real bearer measured 1821 chars with its second dot near 1478: build one that long.
    const long = realLookingJwt("long", 1000);
    expect(long.indexOf(".", long.indexOf(".") + 1)).toBeGreaterThan(200);
    const dir = tree({ "response-1.json": `{"message":"rejected ${long.slice(0, 200)}"}` });
    expect(kinds(dir)).toEqual(["jwt-prefix"]);
  });

  test("an rt_ refresh token of 20+ characters", () => {
    const rt = `rt_${b64url(bytes("rt", 24))}`;
    const dir = tree({ "serve-1-stderr.txt": `refresh with ${rt} failed` });
    expect(kinds(dir)).toEqual(["rt-token"]);
  });

  test("an opaque value in a refresh_token, refreshToken, access_token, accessToken or presented field", () => {
    const opaque = (s: string) => b64url(bytes(s, 18));
    const dir = tree({
      "bodies/001-token.json": `{"grant_type":"refresh_token","refresh_token":"${opaque("a")}"}`,
      "fake.jsonl": `{"exchange":{"presented":"${opaque("b")}","outcome":"ok"}}`,
      "keychain.json": `{"accessToken":"${opaque("c")}","refreshToken":"${opaque("d")}"}`,
      "form.txt": `grant_type=refresh_token&access_token=${opaque("e")}`,
    });
    expect(kinds(dir).sort()).toEqual(Array(5).fill("credential-field"));
  });

  test("a field nested in an escaped JSON string is read through the decoder", () => {
    const dir = tree({
      "result.json": `{"detail":"{\\"refresh_token\\":\\"${b64url(bytes("n", 18))}\\"}"}`,
    });
    expect(kinds(dir)).toEqual(["credential-field/json-escaped"]);
  });

  test("the bench's own values and placeholders in those fields are not findings", () => {
    const dir = tree({
      "fake.jsonl": `{"exchange":{"presented":"refresh-A","issued":"rt-rotated-1"},"refresh_token":"refresh-legacy","accessToken":"at-rotated-2","x":{"access_token":"<UUID>","refreshToken":"short"}}`,
    });
    expect(scanCredentialShapes(dir, []).findings).toEqual([]);
  });

  // Review round 7 (GPT MEDIUM): a run was decoded only up to BASE64_MAX_RUN characters.
  test("a key after BASE64_MAX_RUN in a 349,588-char base64 body is found", () => {
    const tail = Buffer.from(`Bearer ${realLookingSk()} end`);
    const decodedLength = (349_588 / 4) * 3;
    const raw = Buffer.concat([bytes("pad", decodedLength - tail.length), tail]);
    const body = raw.toString("base64");
    expect(body.length).toBe(349_588);
    // The key's encoded position is past the old cap.
    expect(((decodedLength - tail.length) / 3) * 4).toBeGreaterThan(BASE64_MAX_RUN);
    const dir = tree({ "bodies/001-main.json": `{"bodyBase64":"${body}"}` });
    expect(kinds(dir)).toEqual(["sk-key/base64"]);
  });

  // Review round 8 (GPT MEDIUM): a decoded match was placed at its RUN's start. A run that
  // began in an earlier file window starts at index 0 of the next one (the look-behind byte),
  // so every match there was dropped as the earlier window's, and that window never saw it.
  describe("R8-3: a base64 run longer than one file window", () => {
    const PREFIX = '{"bodyBase64":"';
    /** One base64 run: `fillerBytes` of filler, ` Bearer <key> `, 30,000 more. */
    const longRun = (fillerBytes: number, sk: string) => {
      const raw = Buffer.concat([
        Buffer.alloc(fillerBytes, "A"),
        Buffer.from(` Bearer ${sk} `),
        Buffer.alloc(30_000, "A"),
      ]);
      return `${PREFIX}${raw.toString("base64")}"}`;
    };
    /** File offset of the 4-char group carrying decoded byte `d` of the run. */
    const groupOffset = (d: number) => PREFIX.length + 4 * Math.floor(d / 3);

    test("a key past SCAN_CHUNK_BYTES + SCAN_OVERLAP_BYTES in one run of a >4.06 MiB file is found once", () => {
      const sk = realLookingSk();
      const filler = 3_300_000;
      const text = longRun(filler, sk);
      const at = groupOffset(filler + " Bearer ".length);
      expect(text.length).toBeGreaterThan(SCAN_CHUNK_BYTES + SCAN_OVERLAP_BYTES);
      expect(at).toBeGreaterThan(SCAN_CHUNK_BYTES + SCAN_OVERLAP_BYTES);
      const dir = tree({ "bodies/001-main.json": text });
      const { findings } = scanCredentialShapes(dir, []);
      expect(findings.map((f) => `${f.kind}/${f.encoding}`)).toEqual(["sk-key/base64"]);
      // Placed at the key's own encoded characters, not at the run's start (offset 15).
      expect(findings[0]?.offset).toBe(at);
      expect(findings[0]?.length).toBe(sk.length);
    });

    test("a key in the overlap after the first window's owned bytes is found once, by the second window", () => {
      const sk = realLookingSk();
      // Its encoded group starts a little past SCAN_CHUNK_BYTES: both windows read it whole.
      const filler = Math.ceil(((SCAN_CHUNK_BYTES + 1_000 - PREFIX.length) / 4) * 3);
      const at = groupOffset(filler + " Bearer ".length);
      expect(at).toBeGreaterThan(SCAN_CHUNK_BYTES);
      expect(at).toBeLessThan(SCAN_CHUNK_BYTES + SCAN_OVERLAP_BYTES - 2_000);
      const dir = tree({ "a.json": longRun(filler, sk) });
      const { findings } = scanCredentialShapes(dir, []);
      expect(findings.map((f) => f.offset)).toEqual([at]);
    });
  });

  test("base64Blocks covers a run whole, 4-aligned, each overlap long enough", () => {
    for (const length of [80, BASE64_MAX_RUN, BASE64_MAX_RUN + 1, 349_588, 3_000_001]) {
      const blocks = base64Blocks(length);
      expect(blocks[0]?.[0]).toBe(0);
      expect(blocks.at(-1)?.[1]).toBe(length);
      for (const [i, [from, to]] of blocks.entries()) {
        expect(from % 4).toBe(0);
        expect(to - from).toBeLessThanOrEqual(BASE64_MAX_RUN);
        const prev = blocks[i - 1];
        if (prev) expect(prev[1] - from).toBe(BASE64_BLOCK_OVERLAP);
      }
    }
  });

  test("no finding message holds any part of an encoded value", () => {
    const body = Buffer.from(`Bearer ${jwt}`).toString("base64");
    const dir = tree({ "a.json": `{"b":"${body}","c":"${jwt.replaceAll(".", "\\u002e")}"}` });
    const text = realCredentialFindings(dir, []).join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(holdsNoPartOf(text, jwt.slice(3))).toBe(true);
    expect(holdsNoPartOf(text, body)).toBe(true);
  });
});

describe("files written after the directory scan are scanned in memory (review round 6, C2)", () => {
  test("redactCredentialShapes names each value by hash and removes it; the JSON stays valid", () => {
    const jwt = realLookingJwt("late", 1000);
    const text = JSON.stringify({ notes: { harnessError: `first error: ${jwt.slice(0, 160)}` } });
    const r = redactCredentialShapes(text, [], "result.json");
    expect(r.findings.map((f) => f.kind)).toEqual(["jwt-prefix"]);
    expect(holdsNoPartOf(r.text, jwt.slice(3, 160))).toBe(true);
    expect(JSON.parse(r.text).notes.harnessError).toMatch(
      /^first error: <redacted 160 chars, sha256 [0-9a-f]{12}>$/
    );
  });

  test("writeScanned writes the redacted text and returns the findings", () => {
    const dir = tree({});
    const sk = realLookingSk();
    const found = writeScanned(join(dir, "outcome.json"), `{"failedChecks":["${sk}"]}`, []);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("sk-key-shaped credential");
    expect(readFileSync(join(dir, "outcome.json"), "utf8")).not.toContain(sk.slice(3, 12));
    expect(writeScanned(join(dir, "clean.json"), '{"ok":true}', [])).toEqual([]);
  });
});

describe("a finding never prints the value", () => {
  test("harness, E20 and raw scan messages hold length and a sha256 prefix only", () => {
    const jwt = realLookingJwt("print");
    const sk = realLookingSk();
    const dir = tree({
      "fake.jsonl": `Bearer ${jwt}`,
      "stdout.txt": sk,
      "case/candidate/client-response.json": `{"echo":"${sk}"}`,
    });
    const sha = createHash("sha256").update(jwt).digest("hex").slice(0, 12);
    const harness = realCredentialFindings(dir, []).join("\n");
    expect(harness).toContain(`sha256 ${sha}`);
    const e20 = scanSecrets(dir).violations.join("\n");
    expect(e20).toContain(`sha256 ${sha}`);
    for (const message of [harness, e20]) {
      expect(holdsNoPartOf(message, jwt.slice(3))).toBe(true);
      expect(holdsNoPartOf(message, sk.slice(3))).toBe(true);
    }
  });
});
