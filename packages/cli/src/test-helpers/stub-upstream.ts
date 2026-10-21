/**
 * A scripted provider for hermetic end-to-end hook tests (hook-system §11.2). Test-only.
 *
 * `startStubUpstream({ format, script })` starts a `Bun.serve` on 127.0.0.1 that
 * answers EVERY POST with the next scripted response in the given stream format and
 * records each request body. A pane child reaches it through a `customEndpoints`
 * entry in the config file named by `CLAUDISH_CONFIG` (`stubEndpointConfig`), so
 * `stub@fake-model` routes here.
 *
 * A response is a list of parts — text, thinking, tool calls (a tool-only response
 * is a list with only tool calls) — streamed as one event per delta. Chunk size and
 * the delay between network chunks are controllable, and `splitMultibyte` cuts one
 * network chunk inside a multi-byte UTF-8 character, so a parser's decoder must carry
 * the partial character across reads.
 */

export type StubFormat = "openai-sse" | "anthropic-sse" | "openai-responses-sse";

export type StubPart =
  | { text: string }
  | { thinking: string }
  | { toolCall: { name: string; args: Record<string, unknown>; id?: string } };

export interface StubResponse {
  parts: StubPart[];
  /** split each text/thinking part into deltas of this many characters (default: one delta) */
  deltaChars?: number;
  /** delay before each network chunk after the first (default 0) */
  chunkDelayMs?: number;
  /** cut one network chunk inside the first multi-byte character of the body */
  splitMultibyte?: boolean;
  /** an HTTP error status instead of a stream */
  status?: number;
}

export interface StubRequest {
  path: string;
  body: unknown;
  at: number;
}

export interface StubUpstream {
  url: string;
  requests: StubRequest[];
  stop(): void;
}

export type StubScript = StubResponse[] | ((req: StubRequest, n: number) => StubResponse);

function pieces(s: string, n: number | undefined): string[] {
  if (!n || n <= 0 || s.length <= n) return [s];
  const out: string[] = [];
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(""));
  return out;
}

const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

/** Every event of one response, as SSE text, in order. */
export function stubEvents(format: StubFormat, r: StubResponse, model = "fake-model"): string[] {
  switch (format) {
    case "openai-sse":
      return openaiEvents(r, model);
    case "anthropic-sse":
      return anthropicEvents(r, model);
    case "openai-responses-sse":
      return responsesEvents(r, model);
  }
}

function openaiEvents(r: StubResponse, model: string): string[] {
  const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    sse({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const out = [chunk({ role: "assistant", content: "" })];
  let tool = 0;
  for (const p of r.parts) {
    if ("text" in p) for (const t of pieces(p.text, r.deltaChars)) out.push(chunk({ content: t }));
    else if ("thinking" in p)
      for (const t of pieces(p.thinking, r.deltaChars)) out.push(chunk({ reasoning_content: t }));
    else {
      const args = JSON.stringify(p.toolCall.args);
      const id = p.toolCall.id ?? `call_stub_${tool}`;
      out.push(
        chunk({
          tool_calls: [
            {
              index: tool,
              id,
              type: "function",
              function: { name: p.toolCall.name, arguments: "" },
            },
          ],
        })
      );
      for (const a of pieces(args, r.deltaChars))
        out.push(chunk({ tool_calls: [{ index: tool, function: { arguments: a } }] }));
      tool++;
    }
  }
  out.push(chunk({}, tool > 0 ? "tool_calls" : "stop"));
  out.push(
    sse({
      ...base,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  );
  out.push(sse("[DONE]"));
  return out;
}

function anthropicEvents(r: StubResponse, model: string): string[] {
  const out = [
    sse(
      {
        type: "message_start",
        message: {
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      "message_start"
    ),
  ];
  let index = 0;
  let tool = 0;
  for (const p of r.parts) {
    if ("text" in p) {
      out.push(
        sse(
          { type: "content_block_start", index, content_block: { type: "text", text: "" } },
          "content_block_start"
        )
      );
      for (const t of pieces(p.text, r.deltaChars))
        out.push(
          sse(
            { type: "content_block_delta", index, delta: { type: "text_delta", text: t } },
            "content_block_delta"
          )
        );
    } else if ("thinking" in p) {
      out.push(
        sse(
          { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
          "content_block_start"
        )
      );
      for (const t of pieces(p.thinking, r.deltaChars))
        out.push(
          sse(
            { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: t } },
            "content_block_delta"
          )
        );
      out.push(
        sse(
          {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: "c3R1Yg==" },
          },
          "content_block_delta"
        )
      );
    } else {
      const id = p.toolCall.id ?? `toolu_stub_${tool++}`;
      out.push(
        sse(
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id, name: p.toolCall.name, input: {} },
          },
          "content_block_start"
        )
      );
      for (const a of pieces(JSON.stringify(p.toolCall.args), r.deltaChars))
        out.push(
          sse(
            {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: a },
            },
            "content_block_delta"
          )
        );
    }
    out.push(sse({ type: "content_block_stop", index }, "content_block_stop"));
    index++;
  }
  const toolUse = r.parts.some((p) => "toolCall" in p);
  out.push(
    sse(
      {
        type: "message_delta",
        delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      "message_delta"
    )
  );
  out.push(sse({ type: "message_stop" }, "message_stop"));
  return out;
}

function responsesEvents(r: StubResponse, model: string): string[] {
  const out = [
    sse(
      { type: "response.created", response: { id: "resp_stub", model, status: "in_progress" } },
      "response.created"
    ),
  ];
  let item = 0;
  for (const p of r.parts) {
    if ("text" in p) {
      const id = `msg_stub_${item}`;
      out.push(
        sse(
          {
            type: "response.output_item.added",
            output_index: item,
            item: { id, type: "message", role: "assistant", content: [] },
          },
          "response.output_item.added"
        )
      );
      for (const t of pieces(p.text, r.deltaChars))
        out.push(
          sse(
            {
              type: "response.output_text.delta",
              item_id: id,
              output_index: item,
              content_index: 0,
              delta: t,
            },
            "response.output_text.delta"
          )
        );
      out.push(
        sse(
          {
            type: "response.output_item.done",
            output_index: item,
            item: {
              id,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: p.text }],
            },
          },
          "response.output_item.done"
        )
      );
    } else if ("thinking" in p) {
      const id = `rs_stub_${item}`;
      out.push(
        sse(
          {
            type: "response.output_item.added",
            output_index: item,
            item: { id, type: "reasoning", summary: [] },
          },
          "response.output_item.added"
        )
      );
      for (const t of pieces(p.thinking, r.deltaChars))
        out.push(
          sse(
            {
              type: "response.reasoning_summary_text.delta",
              item_id: id,
              output_index: item,
              summary_index: 0,
              delta: t,
            },
            "response.reasoning_summary_text.delta"
          )
        );
      out.push(
        sse(
          {
            type: "response.output_item.done",
            output_index: item,
            item: { id, type: "reasoning" },
          },
          "response.output_item.done"
        )
      );
    } else {
      const id = `fc_stub_${item}`;
      const callId = p.toolCall.id ?? `call_stub_${item}`;
      const args = JSON.stringify(p.toolCall.args);
      out.push(
        sse(
          {
            type: "response.output_item.added",
            output_index: item,
            item: {
              id,
              type: "function_call",
              call_id: callId,
              name: p.toolCall.name,
              arguments: "",
            },
          },
          "response.output_item.added"
        )
      );
      for (const a of pieces(args, r.deltaChars))
        out.push(
          sse(
            {
              type: "response.function_call_arguments.delta",
              item_id: id,
              output_index: item,
              delta: a,
            },
            "response.function_call_arguments.delta"
          )
        );
      out.push(
        sse(
          {
            type: "response.output_item.done",
            output_index: item,
            item: {
              id,
              type: "function_call",
              call_id: callId,
              name: p.toolCall.name,
              arguments: args,
            },
          },
          "response.output_item.done"
        )
      );
    }
    item++;
  }
  out.push(
    sse(
      {
        type: "response.completed",
        response: {
          id: "resp_stub",
          model,
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
      "response.completed"
    )
  );
  return out;
}

/** The network chunks of one response: one per event, or split inside a multi-byte character. */
export function stubChunks(events: string[], splitMultibyte = false): Uint8Array[] {
  const enc = new TextEncoder();
  const chunks = events.map((e) => enc.encode(e));
  if (!splitMultibyte) return chunks;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] as Uint8Array;
    const at = c.findIndex((b) => b >= 0xc0); // the lead byte of a multi-byte sequence
    if (at >= 0) {
      return [
        ...chunks.slice(0, i),
        c.subarray(0, at + 1),
        c.subarray(at + 1),
        ...chunks.slice(i + 1),
      ];
    }
  }
  return chunks;
}

export function startStubUpstream(opts: { format: StubFormat; script: StubScript }): StubUpstream {
  const requests: StubRequest[] = [];
  const pick = (req: StubRequest, n: number): StubResponse => {
    if (typeof opts.script === "function") return opts.script(req, n);
    const list = opts.script;
    return (list[Math.min(n, list.length - 1)] ?? { parts: [{ text: "" }] }) as StubResponse;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST") return Response.json({ data: [] });
      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const rec: StubRequest = { path: url.pathname, body, at: Date.now() };
      const n = requests.length;
      requests.push(rec);
      const r = pick(rec, n);
      if (r.status && r.status >= 400)
        return Response.json(
          { error: { message: `stub error ${r.status}` } },
          { status: r.status }
        );
      const model = (body as { model?: string } | null)?.model ?? "fake-model";
      const chunks = stubChunks(stubEvents(opts.format, r, model), r.splitMultibyte);
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (i >= chunks.length) {
            controller.close();
            return;
          }
          if (i > 0 && r.chunkDelayMs) await Bun.sleep(r.chunkDelayMs);
          controller.enqueue(chunks[i++] as Uint8Array);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * The `customEndpoints` entry that routes `stub@<model>` to a stub (openai-sse only:
 * a `simple` endpoint speaks chat completions). Merge it into the config file a pane
 * child reads through `CLAUDISH_CONFIG`.
 */
export function stubEndpointConfig(stub: StubUpstream, name = "stub"): Record<string, unknown> {
  return {
    customEndpoints: {
      [name]: { kind: "simple", url: `${stub.url}/v1`, format: "openai", authScheme: "none" },
    },
  };
}
