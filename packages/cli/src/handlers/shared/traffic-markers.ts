/**
 * Stdout marker line builders — the traffic-format contract's single source
 * (claudish #72 grain 1, roo-extensions #3391 mirror).
 *
 * `docker logs` stdout is the wire two consumer families parse:
 *  - the MCP tool `claudish_traffic` (roo-state-manager,
 *    mcps/internal/servers/roo-state-manager/src/tools/claudish-traffic.ts)
 *    field-parses `[Request]` lines and lifecycle banners;
 *  - the traffic-*.ps1 scripts and every ad-hoc `grep '\[ttft\]'` count/join
 *    `[resp]` / `[ttft]` lines, keyed by reqN (request-based attribution only:
 *    these lines carry NO machine=).
 *
 * The `[ttft]` template used to exist as THREE inline copies (openai-sse,
 * anthropic-sse, openai-responses-sse) — identical modulo the parser label,
 * each free to drift alone. They now all call ttftMarkerLine, and the
 * producer-side pinning test (fork/middleware/traffic-format-producer.test.ts)
 * holds builders and `__fixtures__/traffic-format/` files to the exact shape,
 * so a format change fails HERE, in the emitting repo — not in the consumer
 * repo weeks later (the #3391 lesson: the parser lives elsewhere, the breakage
 * must be visible at the producer).
 */

/**
 * First-upstream-event marker. Emitted once per stream, on the first `data:`
 * line the parser sees.
 *
 *   `  [ttft] <label> model=<model> reqN=<n> headers=<hdr>ms firstEvent=<fe>ms total=<hdr+fe>ms`
 *
 * - `label` is the PARSER id (openai | anthropic | responses), not the
 *   provider billed — a GLM on the anthropic wire logs `[ttft] anthropic`.
 * - `headers` is dispatch → upstream response headers; `-1` means "not
 *   measured" and MUST also force `total=-1` (never a bogus sum with -1).
 * - On a NOMINAL relay these are the ONLY per-request volume lines (a forwarded
 *   request writes no capture and no [Request] line) — the field order and
 *   units are load-bearing for every latency histogram built from them.
 */
export function ttftMarkerLine(
  label: string,
  model: string,
  reqN: number,
  headerLatencyMs: number | null | undefined,
  firstEventMs: number
): string {
  const hdr = headerLatencyMs ?? -1;
  return `  [ttft] ${label} model=${model} reqN=${reqN} headers=${hdr}ms firstEvent=${firstEventMs}ms total=${
    hdr >= 0 ? hdr + firstEventMs : -1
  }ms\n`;
}

/**
 * Stream-close marker, emitted by createResponseCapture.done() BEFORE the
 * capture write is dispatched (it is the real-time hang signal: a [Request]
 * line whose [resp] never appears means the parser loop never reached close).
 *
 *   `  [resp] <label> model=<model> reqN=<n> events~=<e> bytes=<b> closed=<c> stop=<s> <ms>ms -> <file>`
 *
 * - `closed`/`stop` fall back to `?` when done() carried no value — `?` is a
 *   meaning ("the stream ended without one"), never a bug.
 * - `stop=client-cancel` (closed=false) is how a client abort closes out.
 * - `file` is the in-container capture path; the scripts join req-*↔resp-* by
 *   (pid, reqN), never by parsing this filename.
 */
export function respMarkerLine(
  label: string,
  model: string,
  reqNumber: number,
  events: number,
  bytes: number,
  closed: unknown,
  stopReason: unknown,
  elapsedMs: number,
  file: string
): string {
  return `  [resp] ${label} model=${model} reqN=${reqNumber} events~=${events} bytes=${bytes} closed=${closed} stop=${stopReason} ${elapsedMs}ms -> ${file}\n`;
}

/**
 * Upstream wall line — the candidate half of the two-pass client-error
 * instrument (`docs/reference/traffic-analysis.md` §"Client-visible final
 * errors"). One line per walled upstream step, so on its own it answers "how
 * many walls did we hit", NEVER "how many clients got an error" — the walk is
 * the recovery, and only the absence of a closing `[resp]` makes it a client
 * error.
 *
 *   `Error [<provider>]: HTTP <status> reqN=<n>. <hint>`
 *
 * - NO leading spaces and NO `[claudish] ` prefix: `logStderr` adds both
 *   (`process.stderr.write(\`[claudish] ${message}\n\`)`).
 * - `reqN` is the SAME per-request number `[ttft]`/`[resp]` carry, resolved
 *   from the raw Request at the call site (`requestNumberFor`). That is what
 *   makes pass 2 an exact join (`Error … reqN=K` ↔ `[resp] … reqN=K`) instead
 *   of a temporal adjacency reading — adjacency is only opposable where
 *   interleaving is visible (#601).
 * - This one is emitted on **stderr**, unlike the two markers on stdout: both
 *   streams are interleaved by `docker logs`, which is the wire the instrument
 *   reads.
 */
export function wallMarkerLine(
  providerDisplayName: string,
  status: number,
  reqNumber: number,
  hint: string
): string {
  return `Error [${providerDisplayName}]: HTTP ${status} reqN=${reqNumber}. ${hint}`;
}
