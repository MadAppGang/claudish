import { readFileSync } from "node:fs";
import {
  FRAME_FLAG_END_OF_STREAM,
  createFrameReader,
  envelope,
  msg,
  parseTLV,
} from "../../providers/devin/proto-codec.js";

export const CLEAN_CAPTURE = new Uint8Array(
  readFileSync(new URL("./GetChatMessage-claude-haiku-5-5-low.res.bin", import.meta.url))
);
export const TERMINAL_CAPTURE = new Uint8Array(
  readFileSync(
    new URL("./GetChatMessage-kimi-k3-1-pro-max-parallel-tools.res.bin", import.meta.url)
  )
);

const cleanFrames = createFrameReader()(CLEAN_CAPTURE);
const firstText = cleanFrames.findIndex(
  (frame) => frame.flags === 0 && [...parseTLV(frame.payload)].some((field) => field.no === 3)
);
if (firstText < 0) throw new Error("The healthy Devin capture has no text frame");

// Retain the real header, reasoning and first text frames, without a successful ending.
export const CONTENT_PREFIX = msg(
  ...cleanFrames.slice(0, firstText + 1).map((frame) => envelope(frame.payload, frame.flags))
);

const errorFrame = createFrameReader()(TERMINAL_CAPTURE).find(
  (frame) => frame.flags === FRAME_FLAG_END_OF_STREAM
);
if (!errorFrame) throw new Error("The rejected Devin capture has no error frame");
const capturedErrorPayload = errorFrame.payload;
const capturedError = JSON.parse(new TextDecoder().decode(capturedErrorPayload)) as {
  error: { code: string; message: string };
};
if (capturedError.error.code !== "invalid_argument") {
  throw new Error("The rejected Devin capture does not carry invalid_argument");
}

export function midStreamError(
  code: "invalid_argument" | "unavailable" = "invalid_argument"
): Uint8Array<ArrayBuffer> {
  // Only the captured error's code changes for the retryable classification case.
  const payload =
    code === capturedError.error.code
      ? capturedErrorPayload
      : new TextEncoder().encode(
          JSON.stringify({ ...capturedError, error: { ...capturedError.error, code } })
        );
  return msg(CONTENT_PREFIX, envelope(payload, FRAME_FLAG_END_OF_STREAM));
}
