import { describe, it, expect } from "bun:test";
import { vertexApiHost, buildVertexOAuthEndpoint } from "./vertex-auth.js";

describe("vertexApiHost", () => {
  it("uses the classic single-region host for normal regions", () => {
    expect(vertexApiHost("europe-west4")).toBe(
      "europe-west4-aiplatform.googleapis.com"
    );
    expect(vertexApiHost("us-central1")).toBe(
      "us-central1-aiplatform.googleapis.com"
    );
  });

  it("uses the bare global host for location=global", () => {
    expect(vertexApiHost("global")).toBe("aiplatform.googleapis.com");
  });

  it("uses the data-residency REP host for eu/us multi-region", () => {
    expect(vertexApiHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
    expect(vertexApiHost("us")).toBe("aiplatform.us.rep.googleapis.com");
  });
});

describe("buildVertexOAuthEndpoint (google)", () => {
  const cfg = { projectId: "p", location: "eu" };

  it("targets the EU REP host while keeping the locations/<loc> path", () => {
    expect(
      buildVertexOAuthEndpoint(cfg, "google", "gemini-3.5-flash", false)
    ).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/" +
        "projects/p/locations/eu/publishers/google/models/" +
        "gemini-3.5-flash:generateContent"
    );
  });

  it("appends ?alt=sse for streaming", () => {
    expect(
      buildVertexOAuthEndpoint(cfg, "google", "gemini-3.5-flash", true)
    ).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/" +
        "projects/p/locations/eu/publishers/google/models/" +
        "gemini-3.5-flash:streamGenerateContent?alt=sse"
    );
  });

  it("still builds the classic regional host for a normal region", () => {
    expect(
      buildVertexOAuthEndpoint(
        { projectId: "p", location: "europe-west4" },
        "google",
        "gemini-2.5-pro",
        false
      )
    ).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/" +
        "projects/p/locations/europe-west4/publishers/google/models/" +
        "gemini-2.5-pro:generateContent"
    );
  });

  it("targets the bare global host for location=global", () => {
    expect(
      buildVertexOAuthEndpoint(
        { projectId: "p", location: "global" },
        "google",
        "gemini-2.5-pro",
        false
      )
    ).toBe(
      "https://aiplatform.googleapis.com/v1/" +
        "projects/p/locations/global/publishers/google/models/" +
        "gemini-2.5-pro:generateContent"
    );
  });
});
