// REGRESSION: Vertex config TUI showed oauth but offered only "set key" and an unexplained 403 — Fixed in /dev:fix session dev-fix-20261020-235500-vtx01
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetVertexProjectDiscovery } from "../auth/vertex-auth.js";
import * as providers from "./providers.js";

const originalProject = process.env.VERTEX_PROJECT;

function providerDef(catalogName: string): providers.ProviderDef {
  return (
    providers.getProviderDefs().find((p) => p.catalogName === catalogName) ??
    ({ catalogName } as providers.ProviderDef)
  );
}

describe.serial("Vertex Providers-tab actions and guidance", () => {
  beforeEach(() => {
    process.env.VERTEX_PROJECT = "vertex-test-project";
    resetVertexProjectDiscovery();
  });

  afterEach(() => {
    if (originalProject === undefined) delete process.env.VERTEX_PROJECT;
    else process.env.VERTEX_PROJECT = originalProject;
    resetVertexProjectDiscovery();
  });

  test("Vertex without a claudish OAuth slug offers gcloud ADC login", () => {
    const vertex = providerDef("vertex");
    expect(vertex.oauthSlug).toBeUndefined();

    expect(providers.providerLoginAction(vertex)).toEqual({ kind: "gcloud-adc" });
  });

  test("a declared kimi OAuth slug keeps the claudish login action", () => {
    const kimi = { ...providerDef("kimi"), oauthSlug: "kimi" as const };

    expect(providers.providerLoginAction(kimi)).toEqual({ kind: "claudish", slug: "kimi" });
  });

  test("Devin without a claudish OAuth slug offers no login action", () => {
    const devin = providerDef("devin");
    expect(devin.oauthSlug).toBeUndefined();

    expect(providers.providerLoginAction(devin)).toBeUndefined();
  });

  test("the resolved-project credential note states only the project and its source", () => {
    const note = providers.providerCredentialNote(providerDef("vertex"));

    expect(note).toBe("Project vertex-test-project from $VERTEX_PROJECT");
    expect(note).not.toContain("who signs");
  });
});
