# Poe Tool Call Diagnosis Report

## Issue Identified ✅

**Root Cause Found**: The `transformChunk` method in `src/handlers/poe-handler.ts` had a priority bug where `finish_reason` was being processed before `tool_calls`, causing tool calls to be ignored when the finish reason was `"tool_calls"`.

## Fix Applied ✅

**Change Made**: Moved the `tool_calls` detection check to be **first** in the processing order, before `finish_reason` and other checks.

```typescript
// BEFORE (buggy order):
if (choice.finish_reason) {
  return { type: "content_block_stop" };
}
// ... other checks ...
if (delta.tool_calls) {
  return { type: "tool_calls", tool_calls: delta.tool_calls };
}

// AFTER (fixed order):
if (delta.tool_calls) {
  return { type: "tool_calls", tool_calls: delta.tool_calls };
}
// ... other checks ...
if (choice.finish_reason) {
  return { type: "content_block_stop" };
}
```

## Test Results ✅

**Isolated Handler Tests**: All 6 tests passing
- ✅ Tool calls detected and transformed correctly
- ✅ Streaming tool call chunks processed properly
- ✅ Text responses handled normally
- ✅ Malformed tool calls handled gracefully
- ✅ Tool call processing verified
- ✅ Diagnostic logging working

## What This Means

1. **Tool calls from Poe API are no longer being ignored**
2. **The transformChunk method now properly converts OpenAI tool_calls to Claude format**
3. **The priority order ensures tool calls are processed even when finish_reason is present**

## Next Steps for Verification

1. **Test with real Poe API key**:
```bash
export POE_API_KEY="your-key"
./dist/index.js --model poe/grok-4 --debug "Use calculator: 2+2"
```

2. **Check logs for tool call processing**:
```bash
tail -f logs/claudish_*.log | grep -E "tool_calls|tool_use|content_block"
```

3. **Test with Claude Code** - tool calls should now appear as executable tools instead of plain text.

## Files Modified

- `src/handlers/poe-handler.ts` - Fixed priority order in transformChunk method
- `tests/poe-tool-calls/01-isolated-handler.test.ts` - Comprehensive test suite

## Expected Behavior After Fix

- ✅ Poe models should now be able to execute tools through Claude Code
- ✅ Tool calls should appear as executable tools, not plain text
- ✅ Complete tool call lifecycle should work (start → arguments → stop)
- ✅ Backward compatibility maintained for non-tool responses

The critical bug that was preventing tool calls from being processed has been identified and fixed. The elegant test suite confirms the fix is working correctly at the core handler level.