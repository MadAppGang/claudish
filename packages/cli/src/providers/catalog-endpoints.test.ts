import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { catalogUrl, modelsBaseUrl, plansUrl, probeModelsUrl } from "./catalog-endpoints.js";

const VARS = ["CLAUDISH_CATALOG_URL", "CLAUDISH_PLANS_URL", "CLAUDISH_PROBE_MODELS_URL"] as const;
const saved: Partial<Record<(typeof VARS)[number], string>> = {};

beforeEach(() => {
  for (const name of VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("models-index endpoints", () => {
  test("default to the published service, each on its own path", () => {
    const host = new URL(catalogUrl()).origin;
    expect(new URL(catalogUrl()).pathname).toBe("/queryModels");
    expect(new URL(catalogUrl()).searchParams.get("catalog")).toBe("slim");
    expect(modelsBaseUrl()).toBe(`${host}/queryModels`);
    expect(plansUrl()).toBe(`${host}/queryPlans`);
    expect(probeModelsUrl()).toBe(`${host}/probeModels`);
  });

  test("follow CLAUDISH_CATALOG_URL to another host, without its query", () => {
    process.env.CLAUDISH_CATALOG_URL = "http://127.0.0.1:9911/queryModels?catalog=slim&limit=5";
    expect(modelsBaseUrl()).toBe("http://127.0.0.1:9911/queryModels");
    expect(plansUrl()).toBe("http://127.0.0.1:9911/queryPlans");
    expect(probeModelsUrl()).toBe("http://127.0.0.1:9911/probeModels");
  });

  test("an explicit plans or probe URL wins over the derived one", () => {
    process.env.CLAUDISH_CATALOG_URL = "http://127.0.0.1:9911/queryModels";
    process.env.CLAUDISH_PLANS_URL = "http://plans.test/list";
    process.env.CLAUDISH_PROBE_MODELS_URL = "http://probes.test/list";
    expect(plansUrl()).toBe("http://plans.test/list");
    expect(probeModelsUrl()).toBe("http://probes.test/list");
    expect(modelsBaseUrl()).toBe("http://127.0.0.1:9911/queryModels");
  });

  test("resolve per call, so a setting made after import still applies", () => {
    const before = modelsBaseUrl();
    process.env.CLAUDISH_CATALOG_URL = "http://127.0.0.1:9912/queryModels";
    expect(modelsBaseUrl()).toBe("http://127.0.0.1:9912/queryModels");
    delete process.env.CLAUDISH_CATALOG_URL;
    expect(modelsBaseUrl()).toBe(before);
  });
});
