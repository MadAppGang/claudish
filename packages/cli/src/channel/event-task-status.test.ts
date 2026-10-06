/**
 * Every channel event projects onto SEP-1686's `TaskStatus` explicitly. A missing
 * key does not throw: `mapEventToTaskStatus` falls through to "working", which is how
 * `timeout` once reported a dead session as alive and how `awaiting_permission`
 * reported a session waiting on its caller as busy. This walks the runtime list of
 * event types, so a new type needs a row here AND a key in the map.
 */

import { describe, expect, test } from "bun:test";
import { mapEventToTaskStatus } from "../mcp-server.js";
import { CHANNEL_EVENT_TYPES, type ChannelEventType } from "./types.js";

type TaskStatus = ReturnType<typeof mapEventToTaskStatus>;

const EXPECTED = {
  starting: "working",
  running: "working",
  tool_executing: "working",
  waiting_for_input: "input_required",
  awaiting_permission: "input_required",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  timeout: "failed",
} as const satisfies Record<ChannelEventType, TaskStatus>;

describe("EVENT_TO_TASK_STATUS", () => {
  for (const event of CHANNEL_EVENT_TYPES) {
    test(`${event} → ${EXPECTED[event]}`, () => {
      expect(mapEventToTaskStatus(event)).toBe(EXPECTED[event]);
    });
  }

  test("awaiting_permission asks the caller for input; it is not 'working'", () => {
    expect(mapEventToTaskStatus("awaiting_permission")).toBe("input_required");
  });

  test("finishing is no longer a channel event (RB1): it falls through like any unknown word", () => {
    expect((CHANNEL_EVENT_TYPES as readonly string[]).includes("finishing")).toBe(false);
  });

  test("the list and the table name the same events", () => {
    const listed: string[] = [...CHANNEL_EVENT_TYPES].sort();
    expect(listed).toEqual(Object.keys(EXPECTED).sort());
  });
});
