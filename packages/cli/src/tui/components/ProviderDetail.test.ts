import { describe, expect, test } from "bun:test";
import { credentialNoteLines, resolveProviderDetailKeyDisplay } from "./ProviderDetail.js";

describe("resolveProviderDetailKeyDisplay", () => {
  test("shows OAuth as the active credential instead of an empty key", () => {
    expect(
      resolveProviderDetailKeyDisplay({
        isLocal: false,
        isReady: true,
        authSource: "oauth",
        hasEnvKey: false,
        hasCfgKey: false,
        envKeyMask: "",
        cfgKeyMask: "",
      })
    ).toBe("oauth");
  });

  test("keeps the runtime env key ahead of a shadowed config key", () => {
    expect(
      resolveProviderDetailKeyDisplay({
        isLocal: false,
        isReady: true,
        authSource: "e+c",
        hasEnvKey: true,
        hasCfgKey: true,
        envKeyMask: "env-mask",
        cfgKeyMask: "cfg-mask",
      })
    ).toBe("env-mask");
  });
});

// REGRESSION: Vertex Auth note overflowed DETAIL_H and painted over the Status row — /dev:fix session dev-fix-20261020-235500-vtx01
describe("credentialNoteLines", () => {
  const note =
    "Project xlabs-test from `gcloud config get project` — ADC login (who signs) and project (who pays) must be one Google account; press l to run gcloud auth application-default login";
  const width = 85;
  const maxWidth = width - 4 - 7;

  test("keeps a short note unchanged in one line with or without a failure", () => {
    const shortNote = "Project xlabs-test from ADC";
    expect(credentialNoteLines(shortNote, width, false)).toEqual([shortNote]);
    expect(credentialNoteLines(shortNote, width, true)).toEqual([shortNote]);
  });

  test("collapses whitespace in a short note", () => {
    expect(credentialNoteLines("  Project\txlabs-test\nfrom   ADC  ", width, false)).toEqual([
      "Project xlabs-test from ADC",
    ]);
  });

  test("bounds a long note to two indented-width lines without a failure", () => {
    const lines = credentialNoteLines(note, width, false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("Project xlabs-test");
    expect(lines[1]).toEndWith("…");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(maxWidth);
  });

  test("bounds a long note to one indented-width line during a failure", () => {
    const lines = credentialNoteLines(note, width, true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("Project xlabs-test");
    expect(lines[0]).toEndWith("…");
    expect(lines[0]?.length).toBeLessThanOrEqual(maxWidth);
  });
});
