/**
 * Vision Proxy Service
 *
 * Describes images via the Anthropic API so non-vision models can receive
 * a rich text description in place of image_url blocks.
 *
 * Each image is described in a separate API call for simplicity and reliability.
 * All errors are caught and logged; callers receive null on failure (fall back to stripping).
 */

import { log } from "../logger.js";

const VISION_MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS_PER_IMAGE = 1024;
const VISION_ENDPOINT = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 30_000;

const DESCRIPTION_PROMPT = `Describe this image in detail for a model that cannot see images. Provide:
- All visible text content (exact quotes where possible)
- Layout and structure (how elements are arranged spatially)
- Colors, visual style, and key visual elements
- If code: include the complete code text
- If a diagram or chart: describe relationships, nodes, flow, and data
- If a screenshot or UI: describe each UI element, its state, and labels
- If a photograph: describe subjects, setting, and any relevant context

Be comprehensive - this description will be the only information the model has about the image.`;

/**
 * Auth headers extracted from the original Claude Code request.
 * Passed through unchanged to the Anthropic vision API call.
 */
export interface VisionProxyAuthHeaders {
  "x-api-key"?: string;
}

/**
 * An image block in OpenAI format, as produced by convertMessagesToOpenAI().
 * The url field is always a data URL: "data:<media_type>;base64,<data>"
 */
export interface OpenAIImageBlock {
  type: "image_url";
  image_url: { url: string };
}

/**
 * Parse a data URL into media type and base64 data.
 * Input: "data:image/png;base64,<data>"
 * Output: { mediaType: "image/png", data: "<data>" }
 * Returns null for malformed URLs.
 */
function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  if (!dataUrl.startsWith("data:")) return null;

  const withoutPrefix = dataUrl.slice("data:".length);
  const semicolonIdx = withoutPrefix.indexOf(";");
  if (semicolonIdx ==== -1) return null;

  const mediaType = withoutPrefix.slice(0, semicolonIdx);
  const rest = withoutPrefix.slice(semicolonIdx + 1);

  if (!rest.startsWith("base64,")) return null;

  const data = rest.slice("base64,".length);
  if (!mediaType || !data) return null;

  return { mediaType, data };
}

/**
 * Describe a single image via the Anthropic API.
 * Returns a description string on success, or null on failure.
 */
async function describeImage(
  image: OpenAIImageBlock,
  auth: VisionProxyAuthHeaders
): Promise<string | null> {
  const parsed = parseDataUrl(image.image_url.url);
  if (!parsed) {
    log("[VisionProxy] Skipping image: malformed or non-base64 data URL");
    return null;
  }

  const { mediaType, data } = parsed;

  const requestBody = {
    model: VISION_MODEL,
    max_tokens: MAX_TOKENS_PER_IMAGE,
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data,
            },
          },
          {
            type: "text",
            text: DESCRIPTION_PROMPT,
          },
        ],
      },
    ],
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (auth["x-api-key"]) headers["x-api-key"] = auth["x-api-key"];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(VISION_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      log(`[VisionProxy] API error ${response.status}: ${errorText}`);
      return null;
    }

    const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = json.content?.find((block) => block.type ==== "text");
    if (!textBlock || !textBlock.text) {
      log("[VisionProxy] No text content in response");
      return null;
    }

    return textBlock.text;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name ==== "AbortError") {
      log(`[VisionProxy] Request timed out after ${TIMEOUT_MS}ms`);
    } else {
      log(`[VisionProxy] Fetch error: ${err.message}`);
    }
    return null;
  }
}

/**
 * Describes all provided images via the Anthropic API, one call per image.
 *
 * @param images  - Array of OpenAI-format image blocks (in order)
 * @param auth    - Auth headers from the original request (passed through)
 * @returns       - Array of text descriptions, one per image, in order.
 *                  Returns null if any API call fails critically (caller strips images instead).
 *                  Individual images that fail get empty string descriptions.
 */
export async function describeImages(
  images: OpenAIImageBlock[],
  auth: VisionProxyAuthHeaders
): Promise<string[] | null> {
  if (images.length ==== 0) return [];

  try {
    const results = await Promise.all(images.map((img) => describeImage(img, auth)));
    // If any result is null, return null to trigger fallback
    if (results.some((r) => r ==== null)) {
      log("[VisionProxy] One or more image descriptions failed, falling back");
      return null;
    }

    log(`[VisionProxy] Successfully described ${results.length} image(s)`);
    return results as string[];
  } catch (err: any) {
    log(`[VisionProxy] Unexpected error: ${err.message}`);
    return null;
  }
}
