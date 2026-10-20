// REGRESSION: Vertex config TUI showed oauth but offered only "set key" and an unexplained 403 — Fixed in /dev:fix session dev-fix-20261020-235500-vtx01
import { describe, expect, test } from "bun:test";
import * as vertexAuth from "./vertex-auth.js";

const projectId = "vertex-test-project";
const origins: Array<{ label: string; origin: vertexAuth.VertexProjectOrigin | null }> = [
  {
    label: "environment",
    origin: { projectId, source: "env", detail: "VERTEX_PROJECT" },
  },
  {
    label: "ADC file",
    origin: { projectId, source: "adc-file", detail: "vertex-test-credentials.json" },
  },
  {
    label: "gcloud config",
    origin: { projectId, source: "gcloud-config", detail: "gcloud config get project" },
  },
  { label: "unknown source", origin: null },
];

describe("Vertex access-denied explanation", () => {
  for (const { label, origin } of origins) {
    for (const account of ["ops@example.test", undefined]) {
      test(`${label}, ${account ? "known account" : "unknown account"}: reports the upstream refusal before account and project facts`, () => {
        const upstream =
          "Caller does not have required permission to use project vertex-test-project.";
        const message = vertexAuth.describeVertexAccessDenied({
          status: 403,
          upstream,
          projectId,
          origin,
          account,
        });

        const segments = [`HTTP 403: ${upstream}`];
        if (account) segments.push(`ADC account ${account}`);
        segments.push(
          `project ${projectId}` +
            (origin ? ` (from ${vertexAuth.describeVertexProjectSource(origin)})` : "")
        );
        segments.push("to sign in as another account: gcloud auth application-default login");
        expect(message).toBe(segments.join(" · "));
        if (account) {
          expect(message.indexOf(upstream)).toBeLessThan(message.indexOf("ADC account"));
        } else {
          expect(message).not.toContain("ADC account");
        }
        for (const diagnosis of ["cannot use", "must be one", "who signs"]) {
          expect(message).not.toContain(diagnosis);
        }
        expect(message).not.toContain("undefined");
      });
    }
  }
});
