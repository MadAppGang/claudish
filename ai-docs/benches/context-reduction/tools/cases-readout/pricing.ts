// List prices for the readouts, USD per 1M tokens, and the cost of one
// request at them.
//
// A model with an upper band (Haiku 5.5) is priced per request: a request
// whose total input (fresh input + cache writes + cache reads) is above the
// band edge pays the upper band on all of its tokens. The cloud models catalog
// publishes the band edge as `maxInputTokens` and does not say whether cached
// tokens count toward it; counting them is this module's assumption, to be
// checked against madbench's own cost on the first trial that crosses it.
//
// Cache writes are a multiple of the band's input price: w5m for the
// 5-minute TTL, w1h for the 1-hour TTL.

export type Band = { input: number; output: number; read: number };
export type Price = Band & { w5m: number; w1h: number; above?: { edge: number } & Band };

export const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, read: 0.2, w5m: 1.25, w1h: 2 },
  "claude-opus-5-5": { input: 4, output: 20, read: 0.2, w5m: 1.25, w1h: 2 },
  "claude-sonnet-5-5": { input: 2, output: 10, read: 0.1, w5m: 1.25, w1h: 2 },
  // Catalog connection anthropic/direct-api, pricing.type "tiered": tier 1 up
  // to maxInputTokens 100,000; tier 2 up to 1,000,000.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    read: 0.01,
    w5m: 1.25,
    w1h: 2,
    above: { edge: 100_000, input: 0.5, output: 2.5, read: 0.05 },
  },
  // GLM-4.7 on Z.ai's own API (the glm@ route). The cloud models catalog
  // publishes no price for that connection ("unavailable"); these are the
  // rates aggregator sites quote for Z.ai, which charges no cache write.
  "glm-4.7": { input: 0.6, output: 2.2, read: 0.11, w5m: 1, w1h: 1 },
  // GLM-5-Turbo on the same route. Z.ai's pricing page lists no GLM-5-Turbo
  // row and the catalog's z-ai/direct-api connection is "unavailable"; these
  // are the catalog's openrouter/gateway connection prices (generation
  // g-20261116161706980-7c7c9818), whose upstream is Z.ai.
  "glm-5-turbo": { input: 1.2, output: 4, read: 0.24, w5m: 1, w1h: 1 },
};

const M = 1_000_000;

export function priceOf(model: string): Price | undefined {
  // An explicit model spec (glm@glm-5-turbo) is priced as its model.
  const bare = model.replace(/^[a-z0-9-]+@/, "");
  return PRICES[bare] ?? PRICES[bare.replace(/\[.*\]$/, "")];
}

/** The token counts of one request, as its usage reports them. */
export type Usage = { input: number; w5m?: number; w1h?: number; read?: number; output?: number };

/** The total input the band edge is measured on. */
export function totalInput(u: Usage): number {
  return u.input + (u.w5m ?? 0) + (u.w1h ?? 0) + (u.read ?? 0);
}

/** The band a request is priced at, and whether it is the upper one. */
export function bandOf(p: Price, u: Usage): { band: Band; upper: boolean } {
  if (p.above && totalInput(u) > p.above.edge) return { band: p.above, upper: true };
  return { band: p, upper: false };
}

/** The cost of one request in USD. */
export function requestCost(p: Price, u: Usage): number {
  const { band } = bandOf(p, u);
  return (
    (u.input * band.input +
      (u.w5m ?? 0) * band.input * p.w5m +
      (u.w1h ?? 0) * band.input * p.w1h +
      (u.read ?? 0) * band.read +
      (u.output ?? 0) * band.output) /
    M
  );
}
