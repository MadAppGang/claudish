/**
 * LM Link machines through the real discovery entry and the real transport.
 *
 * `CLAUDISH_LMS_BIN` points at a shell script that answers from JSON files, and
 * a local server stands in for LM Studio. A load writes the instance the script
 * then reports, so the two sides agree as they do on a real install.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverContextWindow,
  discoverProviderModelsCatalog,
  invalidateModelDiscovery,
} from "./model-discovery.js";
import type { LocalProvider } from "./provider-registry.js";
import { LocalTransport } from "./transport/local.js";

const SELF = "self-id";
const M1 = "m1-id";

const NATIVE_ROWS = [
  { id: "shared-model", type: "llm", state: "not-loaded", max_context_length: 262_144 },
  { id: "m1-model", type: "llm", state: "not-loaded", max_context_length: 131_072 },
];
const STORED = [
  { modelKey: "shared-model", deviceIdentifier: null },
  { modelKey: "shared-model", deviceIdentifier: M1 },
  { modelKey: "m1-model", deviceIdentifier: M1 },
];

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let loadRequests: string[];
let loadBodies: unknown[];
let loadAuth: (string | null)[];
/** Runs while the server answers a load, as a slow load would. */
let duringLoad: (() => void) | undefined;
let saved: Record<string, string | undefined>;

const ENV_NAMES = [
  "CLAUDISH_LMS_BIN",
  "LMSTUDIO_BASE_URL",
  "CLAUDISH_CONTEXT_WINDOW",
  "LMSTUDIO_API_KEY",
] as const;

function writeInstances(rows: unknown[]): void {
  writeFileSync(join(dir, "ps.json"), JSON.stringify(rows));
}

function preferredWrites(): string[] {
  return readFileSync(join(dir, "set.log"), "utf-8").split("\n").filter(Boolean);
}

function lmStudioConfig(): LocalProvider {
  return {
    name: "lmstudio",
    baseUrl,
    apiPath: "/v1/chat/completions",
    envVar: "",
    prefixes: [],
  };
}

beforeEach(() => {
  invalidateModelDiscovery();
  saved = {};
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  delete process.env.CLAUDISH_CONTEXT_WINDOW;

  dir = mkdtempSync(join(tmpdir(), "claudish-lms-"));
  writeFileSync(join(dir, "set.log"), "");
  writeFileSync(join(dir, "ls.json"), JSON.stringify(STORED));
  writeInstances([]);
  writeFileSync(
    join(dir, "link.json"),
    JSON.stringify({
      deviceIdentifier: SELF,
      preferredDeviceIdentifier: M1,
      peers: [{ deviceIdentifier: M1, deviceName: "m1", status: "connected" }],
    })
  );
  const bin = join(dir, "lms");
  writeFileSync(
    bin,
    `#!/bin/sh
case "$*" in
  "link status --json") cat "${dir}/link.json" ;;
  "ls --json") cat "${dir}/ls.json" ;;
  "ps --json") cat "${dir}/ps.json" ;;
  "link set-preferred-device "*) echo "$4" >> "${dir}/set.log" ;;
  *) exit 1 ;;
esac
`
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDISH_LMS_BIN = bin;

  loadRequests = [];
  loadBodies = [];
  loadAuth = [];
  duringLoad = undefined;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/v0/models") return Response.json({ object: "list", data: NATIVE_ROWS });
      if (path === "/v1/models") return Response.json({ object: "list", data: [] });
      if (path === "/api/v1/models/load") {
        const body = (await req.json()) as { model: string };
        const { model } = body;
        loadRequests.push(model);
        loadBodies.push(body);
        loadAuth.push(req.headers.get("authorization"));
        duringLoad?.();
        writeInstances([
          {
            identifier: model,
            modelKey: model,
            deviceIdentifier: M1,
            contextLength: ((body as { context_length?: number }).context_length ?? 0) + 1_000,
          },
        ]);
        return Response.json({ instance_id: model, status: "loaded" });
      }
      return new Response(null, { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  process.env.LMSTUDIO_BASE_URL = baseUrl;
});

afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  invalidateModelDiscovery();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("lmstudio discovery with LM Link", () => {
  test("lists one row per machine that holds the model", async () => {
    const outcome = await discoverProviderModelsCatalog("lmstudio");

    expect(outcome.kind).toBe("served");
    expect(outcome.kind === "served" ? outcome.models.map((m) => m.id) : []).toEqual([
      "shared-model~local",
      "shared-model~m1",
      "m1-model~m1",
    ]);
  });

  test("a server on another host keeps one unlabelled row per model", async () => {
    // The proxy cannot be another host in a test, so the loopback check is what varies.
    process.env.LMSTUDIO_BASE_URL = baseUrl.replace("127.0.0.1", "lvh.invalid");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(String(input).replace("lvh.invalid", "127.0.0.1"), init)) as typeof fetch;
    try {
      const outcome = await discoverProviderModelsCatalog("lmstudio");

      expect(outcome.kind === "served" ? outcome.models.map((m) => m.id) : []).toEqual([
        "shared-model",
        "m1-model",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("without lms the rows stay unlabelled", async () => {
    process.env.CLAUDISH_LMS_BIN = join(dir, "no-such-binary");

    const outcome = await discoverProviderModelsCatalog("lmstudio");

    expect(outcome.kind === "served" ? outcome.models.map((m) => m.id) : []).toEqual([
      "shared-model",
      "m1-model",
    ]);
  });
});

describe("the window of a machine row under a requested limit", () => {
  test("a limit above the copy's maximum reports that maximum", async () => {
    writeFileSync(
      join(dir, "ls.json"),
      JSON.stringify([
        { modelKey: "shared-model", deviceIdentifier: null },
        { modelKey: "shared-model", deviceIdentifier: M1, maxContextLength: 196_608 },
        { modelKey: "m1-model", deviceIdentifier: M1 },
      ])
    );

    expect(await discoverContextWindow("lmstudio", "shared-model~m1", { upTo: 300_000 })).toBe(
      196_608
    );
    expect(await discoverContextWindow("lmstudio", "shared-model~m1", { upTo: 64_000 })).toBe(
      undefined
    );
  });
});

describe("the window of a spec without a machine suffix", () => {
  test("comes from the instance running on a linked machine", async () => {
    writeInstances([
      {
        identifier: "shared-model",
        modelKey: "shared-model",
        deviceIdentifier: M1,
        contextLength: 32_768,
      },
    ]);

    expect(await discoverContextWindow("lmstudio", "shared-model")).toBe(32_768);
  });
});

describe("LocalTransport with a machine suffix", () => {
  test("the first request's payload names the instance on that machine", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");

    expect(await transport.getExtraPayloadFields()).toEqual({ model: "shared-model" });
    expect(loadRequests).toEqual(["shared-model"]);
    await transport.refreshAuth();
    expect(loadRequests).toEqual(["shared-model"]);
  });

  test("the load sends the key the credential authority resolves, not only the environment's", async () => {
    delete process.env.LMSTUDIO_API_KEY;
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");
    const headers = spyOn(transport, "getHeaders").mockResolvedValue({
      Authorization: "Bearer stored-key",
    });
    try {
      await transport.getExtraPayloadFields();
    } finally {
      headers.mockRestore();
    }

    expect(loadAuth).toEqual(["Bearer stored-key"]);
  });

  test("the context window is the one of that instance", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");

    await transport.getExtraPayloadFields();
    await transport.refreshAuth();

    expect(transport.getContextWindow()).toBe(129_000);
  });

  test("the load asks for the provider's default context length", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");

    await transport.getExtraPayloadFields().catch(() => undefined);

    expect(loadBodies).toEqual([{ model: "shared-model", context_length: 128_000 }]);
  });

  test("CLAUDISH_CONTEXT_WINDOW sets the size the model loads with", async () => {
    process.env.CLAUDISH_CONTEXT_WINDOW = "48000";
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");

    await transport.getExtraPayloadFields();
    await transport.refreshAuth();

    expect(loadBodies).toEqual([{ model: "shared-model", context_length: 48_000 }]);
    expect(transport.getContextWindow()).toBe(48_000);
  });

  test("a limit above the model's maximum reports the size that really loaded", async () => {
    process.env.CLAUDISH_CONTEXT_WINDOW = "256000";
    writeFileSync(
      join(dir, "ls.json"),
      JSON.stringify([{ modelKey: "shared-model", deviceIdentifier: M1, maxContextLength: 32_768 }])
    );
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");

    await transport.getExtraPayloadFields();
    await transport.refreshAuth();

    expect(loadBodies).toEqual([{ model: "shared-model", context_length: 32_768 }]);
    expect(transport.getContextWindow()).toBe(33_768);
  });

  test("a placement is checked again once it is old, and a moved instance fails the request", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");
    await transport.getExtraPayloadFields();
    await transport.refreshAuth();

    writeInstances([
      {
        identifier: "shared-model",
        modelKey: "shared-model",
        deviceIdentifier: null,
        contextLength: 129_000,
      },
    ]);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      await transport.getExtraPayloadFields();
      await expect(transport.refreshAuth()).rejects.toThrow("more than one machine");
    } finally {
      clock.mockRestore();
    }
  });

  test("a load slower than the recheck interval is not checked again in the same request", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    duringLoad = () => {
      offset += 60_000;
    };
    try {
      const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");
      await transport.getExtraPayloadFields();
      // A check now would see this namesake and refuse the request.
      writeInstances([
        {
          identifier: "shared-model",
          modelKey: "shared-model",
          deviceIdentifier: M1,
          contextLength: 129_000,
        },
        {
          identifier: "shared-model",
          modelKey: "shared-model",
          deviceIdentifier: null,
          contextLength: 129_000,
        },
      ]);

      await transport.refreshAuth();
    } finally {
      clock.mockRestore();
    }
  });

  test("a placement error from a request that failed its health check does not fail the next one", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");
    const lms = process.env.CLAUDISH_LMS_BIN;
    process.env.CLAUDISH_LMS_BIN = join(dir, "no-such-binary");
    const health = spyOn(
      transport as unknown as { checkHealth(): Promise<boolean> },
      "checkHealth"
    ).mockResolvedValueOnce(false);
    try {
      expect(await transport.getExtraPayloadFields()).toEqual({});
      await expect(transport.refreshAuth()).rejects.toThrow("Cannot connect");
    } finally {
      health.mockRestore();
      process.env.CLAUDISH_LMS_BIN = lms;
    }

    expect(await transport.getExtraPayloadFields()).toEqual({ model: "shared-model" });
    await transport.refreshAuth();
  });

  test("a recent placement is used without asking lms again", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~m1");
    await transport.getExtraPayloadFields();
    await transport.refreshAuth();

    writeInstances([]);

    expect(await transport.getExtraPayloadFields()).toEqual({ model: "shared-model" });
    await transport.refreshAuth();
  });

  test("a model with no suffix loads nothing and adds no payload field", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model");

    expect(await transport.getExtraPayloadFields()).toEqual({});
    await transport.refreshAuth();

    expect(loadRequests).toEqual([]);
    expect(preferredWrites()).toEqual([]);
  });

  test("an unknown machine fails the request, then the next request tries again", async () => {
    const transport = new LocalTransport(lmStudioConfig(), "shared-model~other");

    expect(await transport.getExtraPayloadFields()).toEqual({});
    await expect(transport.refreshAuth()).rejects.toThrow(/"other" is not connected/);

    writeFileSync(
      join(dir, "link.json"),
      JSON.stringify({
        deviceIdentifier: SELF,
        preferredDeviceIdentifier: M1,
        peers: [{ deviceIdentifier: M1, deviceName: "other", status: "connected" }],
      })
    );

    expect(await transport.getExtraPayloadFields()).toEqual({ model: "shared-model" });
    await transport.refreshAuth();
  });

  test("a loaded suffix on another provider is part of the model name", async () => {
    const config = { ...lmStudioConfig(), name: "vllm" };
    const transport = new LocalTransport(config, "some~model");

    expect(await transport.getExtraPayloadFields()).toEqual({});
    expect(loadRequests).toEqual([]);
  });
});
