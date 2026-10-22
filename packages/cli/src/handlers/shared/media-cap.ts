/**
 * #575 — the vLLM engine's per-prompt image cap: a request-SHAPE incapacity,
 * not a step failure.
 *
 * Measured on the hub, 12/10 → 20/10 (10 occurrences in `upstream-errors.log`;
 * 7 swift, 3 frognano). The engine refuses a prompt carrying more images than
 * its cap BEFORE any token-count consideration, at any body size:
 *
 *   {"error":{"message":"At most 4 image(s) may be provided in one prompt.
 *    (parameter=image)","type":"BadRequestError","param":"image","code":400}}
 *
 * The 20/10 session (CoursIA-2's blocked compaction, 4.4 MB body) retried this
 * shape four times in 45 s; sixteen minutes later the SAME session trimmed to
 * 949 569 B got the real context-overflow 400 and taught the learned cap in one
 * shot. Two different 400s — the diagnosis thread that read the first one as a
 * translation-format problem followed the generic recovery hint.
 *
 * Why it must ride the step-skip wire and not the failure path (#553): the step
 * is healthy, the request is what it cannot take. Benching that step for 10 min
 * would exile a healthy lane over one screenshot-heavy session, and per-step
 * backoff rungs would climb across retries of a shape the step will never
 * accept. `x-claudish-step-skip: media` says exactly what #431 says for the
 * other two shapes: advance, no mark, no wall, no arm.
 *
 * Deliberately NARROW. A bare `"param":"image"` is NOT enough — an invalid
 * image payload (bad base64, unsupported media type) is a genuine request
 * error and must keep its ordinary 400. Only the engine's own cap phrasing
 * classifies.
 */

export interface MediaCapMatch {
  matched: boolean;
  /** The engine's stated per-prompt cap ("At most 4 image(s)" → 4). */
  max?: number;
  /** The refused parameter, when the body names one. */
  param?: string;
}

/** The engine's exact phrasing. Anchored on "may be provided" so arbitrary
 *  mentions of a cap in a usage message cannot classify. */
const MEDIA_CAP_PHRASE = /at most\s+(\d+)\s+image\(s\)\s+may be provided/i;

/**
 * Classify a pre-stream refusal as the engine's image-count cap. Accepts the
 * RAW upstream error body (the same string `appendUpstreamError` captures).
 */
export function classifyMediaCap(status: number, errorBody: string): MediaCapMatch {
  // vLLM answers 400 (`"code":400` in the body is a string-duplicate of it).
  // Narrow on purpose: a 413 is a size refusal and belongs to the overflow
  // classifier's family, never here.
  if (status !== 400) return { matched: false };

  let message = errorBody;
  let param: string | undefined;
  try {
    const parsed = JSON.parse(errorBody);
    const rawMsg = parsed?.error?.message ?? parsed?.message;
    if (rawMsg !== undefined && rawMsg !== null) message = String(rawMsg);
    const rawParam = parsed?.error?.param ?? parsed?.param;
    if (rawParam !== undefined && rawParam !== null) param = String(rawParam);
  } catch {
    // Non-JSON body: the phrase test below still runs on the raw text.
  }

  const m = MEDIA_CAP_PHRASE.exec(message);
  if (!m) return { matched: false };
  const max = Number.parseInt(m[1], 10);
  return { matched: true, max: Number.isFinite(max) ? max : undefined, param };
}

/**
 * The label the reader gets instead of the generic "Request format may be
 * incompatible with provider" — and, on the last step / nominal / non-cascade
 * path, instead of the engine's raw jargon.
 *
 * LOAD-BEARING: never matches `isQuotaExhaustion`. This is a request-shape
 * refusal, not a wall; wording it in quota vocabulary would arm a cascade off
 * a screenshot count. Pinned by test.
 */
export function mediaCapRefusalText(max: number | undefined, carried: number): string {
  const cap = max !== undefined ? `at most ${max} image(s)` : `a limited number of images`;
  const carriedText = carried > 0 ? `, this request carries ${carried}` : "";
  return (
    `[claudish] This step accepts ${cap} per prompt${carriedText}. ` +
    `The engine refuses on the media count, not on the prompt's size — ` +
    `drop or describe images to run on this model.`
  );
}

/** Skip-header detail: countable, and every token is a fact the classifier read. */
export function mediaCapSkipDetail(match: MediaCapMatch, carried: number): string {
  return (
    `images=${carried}` +
    (match.max !== undefined ? ` cap=${match.max}` : "") +
    (match.param ? ` param=${match.param}` : "")
  );
}
