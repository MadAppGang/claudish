import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_ENUM,
  type DevinRequest,
  describeDevinRequestForLog,
  encodeDevinRequest,
} from "./devin-request.js";
import {
  FRAME_HEADER_BYTES,
  type TLV,
  parseTLV,
  readString,
  readVarintValue,
} from "./proto-codec.js";

const metadata = { apiKey: "recognisable-fake-devin-key" };

function encodedBody(request: DevinRequest): Uint8Array {
  return encodeDevinRequest(request, metadata).subarray(FRAME_HEADER_BYTES);
}

function field(fields: TLV[], no: number): TLV {
  const match = fields.find((candidate) => candidate.no === no);
  expect(match).toBeDefined();
  return match!;
}

function messageFields(request: DevinRequest, index = 0): TLV[] {
  const messages = parseTLV(encodedBody(request)).filter(
    (candidate) => candidate.no === 3 && candidate.wire === 2
  );
  expect(messages[index]).toBeDefined();
  return parseTLV(messages[index]!.payload);
}

describe("encodeDevinRequest messages", () => {
  test("maps user, assistant, and tool_result to sources 1, 2, and 4, never 3", () => {
    const request: DevinRequest = {
      modelUid: "synthetic-model-high",
      messages: [
        { id: "user-message", role: "user", text: "question" },
        { id: "assistant-message", role: "assistant", text: "answer" },
        { id: "tool-result-message", role: "tool_result", text: "result" },
      ],
    };

    const sources = parseTLV(encodedBody(request))
      .filter((candidate) => candidate.no === 3 && candidate.wire === 2)
      .map((message) => readVarintValue(field(parseTLV(message.payload), 2)));

    expect(sources).toEqual([1, 2, 4]);
    // Public LanguageServer prior art says assistant=3. ApiServer source 3
    // breaks Claude and GLM while GPT silently tolerates it, so pin it here.
    expect(sources).not.toContain(3);
  });

  test("encodes an assistant tool call in field 6 without a text field 3", () => {
    const request: DevinRequest = {
      modelUid: "synthetic-model-high",
      messages: [
        {
          id: "assistant-tool-message",
          role: "assistant",
          toolCall: {
            id: "call-123",
            name: "read_fixture",
            argumentsJson: '{"path":"fixture.txt"}',
          },
        },
      ],
    };

    const message = messageFields(request);
    expect(readVarintValue(field(message, 2))).toBe(2);
    expect(message.some((candidate) => candidate.no === 3)).toBe(false);

    const toolCall = parseTLV(field(message, 6).payload);
    expect(readString(field(toolCall, 1))).toBe("call-123");
    expect(readString(field(toolCall, 2))).toBe("read_fixture");
    expect(readString(field(toolCall, 3))).toBe('{"path":"fixture.txt"}');
  });

  test("encodes tool results with source 4, result field 3, and call id field 7", () => {
    const request: DevinRequest = {
      modelUid: "synthetic-model-high",
      messages: [
        {
          id: "tool-result-message",
          role: "tool_result",
          text: "fixture contents",
          toolCallId: "call-123",
        },
      ],
    };

    const message = messageFields(request);
    expect(readVarintValue(field(message, 2))).toBe(4);
    expect(readString(field(message, 3))).toBe("fixture contents");
    expect(readString(field(message, 7))).toBe("call-123");
  });
});

describe("encodeDevinRequest routing and envelope", () => {
  test("puts the model uid in field 21 and the required enum in field 7", () => {
    const request: DevinRequest = {
      modelUid: "synthetic-routed-uid-xhigh",
      modelEnum: 17,
      messages: [],
    };
    const fields = parseTLV(encodedBody(request));

    expect(readString(field(fields, 21))).toBe("synthetic-routed-uid-xhigh");
    expect(readVarintValue(field(fields, 7))).toBe(17);
  });

  test("uses the default enum when no override is supplied", () => {
    const fields = parseTLV(encodedBody({ modelUid: "synthetic-model", messages: [] }));
    expect(readVarintValue(field(fields, 7))).toBe(DEFAULT_MODEL_ENUM);
  });

  test("returns an enveloped Connect message with a five-byte header", () => {
    const encoded = encodeDevinRequest(
      { modelUid: "synthetic-model", messages: [{ id: "m1", role: "user", text: "hi" }] },
      metadata
    );
    const declaredLength = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength
    ).getUint32(1, false);

    expect(encoded[0]).toBe(0);
    expect(declaredLength).toBe(encoded.length - FRAME_HEADER_BYTES);
    expect(parseTLV(encoded.subarray(FRAME_HEADER_BYTES)).length).toBeGreaterThan(0);
  });

  test("the log description never contains the api key", () => {
    const fakeKey = "DEVIN_FAKE_KEY_DO_NOT_LOG_7f921";
    const request: DevinRequest = {
      modelUid: "synthetic-model-high",
      system: "Hermetic fixture",
      messages: [{ id: "m1", role: "user", text: "hello" }],
    };
    const encoded = encodeDevinRequest(request, { apiKey: fakeKey });
    const description = describeDevinRequestForLog(request);

    // Prove the recognisable fixture key really was passed into the wire encoder.
    expect(new TextDecoder().decode(encoded)).toContain(fakeKey);
    expect(description).not.toContain(fakeKey);
  });
});
