// REGRESSION: The ADC login could not launch the Cloud SDK's gcloud.cmd on Windows — /dev:fix session dev-fix-20261020-235500-vtx01
import { describe, expect, test } from "bun:test";
import { gcloudCommand } from "./index.js";

describe("gcloudCommand", () => {
  test("uses the Cloud SDK command script on Windows", () => {
    expect(gcloudCommand("win32")).toBe("gcloud.cmd");
  });

  test("keeps the gcloud executable on macOS and Linux", () => {
    expect(gcloudCommand("darwin")).toBe("gcloud");
    expect(gcloudCommand("linux")).toBe("gcloud");
  });
});
