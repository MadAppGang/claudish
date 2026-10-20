// REGRESSION: Vertex config TUI showed oauth but offered only "set key" and an unexplained 403 — Fixed in /dev:fix session dev-fix-20261020-235500-vtx01
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../../auth/credentials/authority.js";
import { resetVertexProjectDiscovery } from "../../auth/vertex-auth.js";
import { _clearVertexDiscoveryCache, discoverVertexProbeModel } from "./vertex-discovery.js";

const originalFetch = globalThis.fetch;
const originalGetRequestAuth = credentials.getRequestAuth;
const originalProject = process.env.VERTEX_PROJECT;
const originalLocation = process.env.VERTEX_LOCATION;
const originalApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const upstreamMessage =
  "Caller does not have required permission to use project vertex-test-project.";

function installHttpResponses(
  tokeninfo: "email" | "400" | "throws",
  response = {
    status: 403,
    body: JSON.stringify({
      error: { code: 403, message: upstreamMessage, status: "PERMISSION_DENIED" },
    }),
  }
): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);

    if (url.endsWith("/v1beta1/publishers/google/models")) {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("x-goog-user-project")).toBe("vertex-test-project");
      return new Response(response.body, { status: response.status });
    }

    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      expect(init?.method ?? (input instanceof Request ? input.method : "GET")).toBe("GET");
      if (tokeninfo === "throws") throw new Error("offline Vertex tokeninfo request failed");
      if (tokeninfo === "400") {
        return Response.json({ error: "invalid_token" }, { status: 400 });
      }
      return Response.json({ email: "ops@example.test" });
    }

    throw new Error(`unexpected Vertex discovery request: ${url}`);
  }) as typeof fetch;
  return requests;
}

function expectAccessDeniedReason(
  reason: string | undefined,
  status = 403,
  upstream = upstreamMessage
): asserts reason is string {
  expect(reason).toStartWith(`Vertex AI model list failed: HTTP ${status}: ${upstream}`);
  expect(reason).toContain("vertex-test-project");
  expect(reason).toContain("gcloud auth application-default login");
  expect(reason).toContain(upstream);
  expect(reason).toContain("$VERTEX_PROJECT");
  expect(reason).not.toContain("undefined");
  for (const diagnosis of ["cannot use", "must be one", "who signs"]) {
    expect(reason).not.toContain(diagnosis);
  }
}

describe.serial("Vertex model-list access denied", () => {
  let credentialDir: string;

  beforeEach(() => {
    credentialDir = mkdtempSync(join(tmpdir(), "claudish-vertex-account-"));
    process.env.VERTEX_PROJECT = "vertex-test-project";
    process.env.VERTEX_LOCATION = "us-central1";
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    resetVertexProjectDiscovery();
    _clearVertexDiscoveryCache();
    credentials.getRequestAuth = async () => ({
      headers: { Authorization: "Bearer offline-vertex-test-token" },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    credentials.getRequestAuth = originalGetRequestAuth;
    if (originalProject === undefined) delete process.env.VERTEX_PROJECT;
    else process.env.VERTEX_PROJECT = originalProject;
    if (originalLocation === undefined) delete process.env.VERTEX_LOCATION;
    else process.env.VERTEX_LOCATION = originalLocation;
    if (originalApplicationCredentials === undefined)
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalApplicationCredentials;
    rmSync(credentialDir, { recursive: true, force: true });
    resetVertexProjectDiscovery();
    _clearVertexDiscoveryCache();
  });

  test("HTTP 403 names the signing account, project source, ADC login and upstream refusal", async () => {
    const requests = installHttpResponses("email");

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expectAccessDeniedReason(result.reason);
    expect(result.reason).toContain("ADC account ops@example.test");
    expect(result.reason.indexOf(upstreamMessage)).toBeLessThan(
      result.reason.indexOf("ADC account")
    );
    expect(requests.some((url) => url.startsWith("https://oauth2.googleapis.com/tokeninfo"))).toBe(
      true
    );
  });

  // REGRESSION: Setting GOOGLE_APPLICATION_CREDENTIALS skipped tokeninfo when client_email was absent — /dev:fix session dev-fix-20261020-235500-vtx01
  test("service_account file names client_email without a tokeninfo request", async () => {
    const credPath = join(credentialDir, "service-account.json");
    writeFileSync(
      credPath,
      JSON.stringify({ type: "service_account", client_email: "service@example.test" }),
      { mode: 0o600 }
    );
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    const requests = installHttpResponses("email");

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expectAccessDeniedReason(result.reason);
    expect(result.reason).toContain("ADC account service@example.test");
    expect(requests).toHaveLength(1);
  });

  for (const type of ["authorized_user", "external_account"]) {
    test(`${type} file names the account from tokeninfo`, async () => {
      const credPath = join(credentialDir, `${type}.json`);
      writeFileSync(credPath, JSON.stringify({ type }), { mode: 0o600 });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
      const requests = installHttpResponses("email");

      const result = await discoverVertexProbeModel();

      expect(result.model).toBeNull();
      expectAccessDeniedReason(result.reason);
      expect(result.reason).toContain("ADC account ops@example.test");
      expect(requests).toContain(
        "https://oauth2.googleapis.com/tokeninfo?access_token=offline-vertex-test-token"
      );
    });
  }

  test("unreadable credential path uses tokeninfo without hiding the upstream refusal", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(credentialDir, "missing.json");
    const requests = installHttpResponses("email");

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expectAccessDeniedReason(result.reason);
    expect(result.reason).toContain("ADC account ops@example.test");
    expect(requests).toContain(
      "https://oauth2.googleapis.com/tokeninfo?access_token=offline-vertex-test-token"
    );
  });

  test("HTTP 403 reports a disabled Vertex AI API without diagnosing an account mismatch", async () => {
    const upstream =
      "Vertex AI API has not been used in project vertex-test-project before or it is disabled.";
    installHttpResponses("email", {
      status: 403,
      body: JSON.stringify({
        error: { code: 403, message: upstream, status: "PERMISSION_DENIED" },
      }),
    });

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expectAccessDeniedReason(result.reason, 403, upstream);
    expect(result.reason.indexOf(upstream)).toBeLessThan(result.reason.indexOf("ADC account"));
  });

  test("HTTP 401 starts with the upstream authentication refusal and retains the sign-in command", async () => {
    const upstream = "Request had invalid authentication credentials.";
    installHttpResponses("email", {
      status: 401,
      body: JSON.stringify({
        error: { code: 401, message: upstream, status: "UNAUTHENTICATED" },
      }),
    });

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expectAccessDeniedReason(result.reason, 401, upstream);
  });

  test("non-JSON HTTP 403 reports the upstream body first", async () => {
    installHttpResponses("email", { status: 403, body: "forbidden" });

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expectAccessDeniedReason(result.reason, 403, "forbidden");
  });

  for (const body of ["", " \n\t"]) {
    test(`empty HTTP 403 body ${JSON.stringify(body)} reports no message`, async () => {
      installHttpResponses("email", { status: 403, body });

      const result = await discoverVertexProbeModel();

      expect(result.model).toBeNull();
      expectAccessDeniedReason(result.reason, 403, "(no message)");
    });
  }

  test("HTTP 400 reports the upstream sentence before the project source without account lookup", async () => {
    const upstream = "Project 'projects/vertex-test-project' not found or deleted.";
    const requests = installHttpResponses("email", {
      status: 400,
      body: JSON.stringify({
        error: { code: 400, message: upstream, status: "INVALID_ARGUMENT" },
      }),
    });

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expect(result.reason).toContain(`HTTP 400: ${upstream}`);
    expect(result.reason).toContain("$VERTEX_PROJECT");
    expect(result.reason).not.toContain("gcloud auth application-default login");
    expect(result.reason).not.toContain("ADC account");
    expect(result.reason).not.toContain("https://");
    expect(result.reason).toContain("project vertex-test-project (from");
    expect(result.reason!.indexOf(upstream)).toBeLessThan(
      result.reason!.indexOf("project vertex-test-project (from")
    );
    expect(requests.some((url) => url.startsWith("https://oauth2.googleapis.com/tokeninfo"))).toBe(
      false
    );
  });

  test("non-JSON HTTP 500 reports the upstream body first", async () => {
    installHttpResponses("email", { status: 500, body: "backend error" });

    const result = await discoverVertexProbeModel();

    expect(result.model).toBeNull();
    expect(result.reason).toContain("HTTP 500: backend error");
  });

  for (const tokeninfo of ["400", "throws"] as const) {
    test(`tokeninfo ${tokeninfo} preserves the actionable HTTP 403 reason without throwing`, async () => {
      const requests = installHttpResponses(tokeninfo);

      const result = await discoverVertexProbeModel();

      expect(result.model).toBeNull();
      expectAccessDeniedReason(result.reason);
      expect(result.reason).not.toContain("ops@example.test");
      expect(result.reason).not.toContain("ADC account");
      expect(
        requests.some((url) => url.startsWith("https://oauth2.googleapis.com/tokeninfo"))
      ).toBe(true);
    });
  }
});
