# Poe Tool Call Debugging Suite

This comprehensive test suite is designed to diagnose exactly where tool calls are being lost in the Poe handler pipeline.

## Test Structure

### 1. Isolated Handler Tests (`01-isolated-handler.test.ts`)
Tests the Poe handler's tool call processing in complete isolation.

**What it tests:**
- `transformChunk()` method tool call detection and conversion
- ContentBlockTracker tool block management
- Tool call data structure transformation
- Error handling for malformed tool calls

**Key diagnostics:**
- Verifies tool calls are not being ignored (`return null`)
- Confirms proper Claude-compatible event generation
- Tests tool block lifecycle management

### 2. End-to-End Proxy Tests (`02-proxy-server-e2e.test.ts`)
Tests the complete request/response pipeline through the proxy server.

**What it tests:**
- Handler selection (Poe vs OpenRouter vs Native)
- Request transformation from Claude to Poe API format
- Response transformation from Poe API to Claude format
- SSE event generation and streaming
- Tool call completion detection

**Key diagnostics:**
- Captures and analyzes all SSE events
- Identifies missing or malformed tool_use events
- Verifies proper model name transformation
- Tests mixed content scenarios (text + tools)

### 3. Claude Code Integration Tests (`03-claude-integration.test.ts`)
Tests the real-world workflow with actual Claude Code protocol.

**What it tests:**
- Server startup and Poe model selection
- Claude Code compatible request handling
- Multi-tool scenarios
- Debug logging and diagnostics
- Handler routing verification

**Key diagnostics:**
- Verifies server accepts Claude Code protocol
- Tests multiple Poe models
- Provides comprehensive debugging output
- Analyzes real server logs and SSE streams

## Diagnostic Utilities

### Mock Poe API Server (`utils/mock-poe-api.ts`)
- Simulates Poe API responses with full control
- Supports streaming tool call responses
- Can inject error scenarios for testing
- Provides consistent test data across all tests

### SSE Analyzer (`utils/sse-analyzer.ts`)
- Parses and analyzes Server-Sent Event streams
- Categorizes events (tool calls, text, errors)
- Identifies incomplete or malformed tool calls
- Generates comprehensive diagnostic reports
- Exports data for external analysis

## Running the Tests

### Phase 1: Isolated Testing
```bash
# Test handler logic in isolation
bun test tests/poe-tool-calls/01-isolated-handler.test.ts --debug

# Expected: All tests pass, confirming tool call processing works
```

### Phase 2: Mock API Testing
```bash
# Test full pipeline with mock API
bun test tests/poe-tool-calls/02-proxy-server-e2e.test.ts --debug

# Expected: Detailed SSE analysis showing tool call flow
```

### Phase 3: Real Integration Testing
```bash
# Test with real Poe API (requires API key)
export POE_API_KEY="your-key"
bun test tests/poe-tool-calls/03-claude-integration.test.ts --debug

# Expected: Real-world debugging information
```

## Interpreting Results

### Success Indicators
- ✅ Tool calls detected in transformChunk
- ✅ content_block_start events with tool_use type
- ✅ input_json_delta events with partial arguments
- ✅ content_block_stop events for tool completion
- ✅ Complete tool call lifecycle in SSE analyzer

### Failure Patterns and Their Meanings

**No tool_calls detected:**
- Issue: Handler not receiving tool calls from Poe API
- Check: Poe API response format, model capabilities

**tool_calls detected but no Claude events:**
- Issue: transformChunk not converting to Claude format
- Check: Lines 650-707 in poe-handler.ts streaming logic

**Claude events generated but malformed:**
- Issue: SSE event structure doesn't match Claude expectations
- Check: Event format, content block structure

**Tool calls incomplete:**
- Issue: Tool block tracking or argument accumulation problems
- Check: ContentBlockTracker implementation

## Debug Output Analysis

### SSE Analyzer Report Structure
```json
{
  "summary": {
    "totalEvents": 15,
    "hasToolCalls": true,
    "hasText": false,
    "hasErrors": false,
    "duration": 1250
  },
  "toolCalls": {
    "hasToolCalls": true,
    "toolCallCount": 1,
    "completeToolCalls": 1,
    "incompleteToolCalls": []
  },
  "recommendations": [
    "Tool calls processed successfully",
    "All events are in correct format"
  ]
}
```

### Key Log Patterns to Watch For
- `Poe Model Detected - Using PoeHandler` - Correct handler selection
- `tool_calls` in Poe API response - Tool calls received from Poe
- `content_block_start` with `tool_use` - Claude-compatible events generated
- `input_json_delta` - Tool arguments streaming correctly
- `finish_reason: "tool_calls"` - Tool call completion detected

## Manual Debugging Steps

If automated tests don't reveal the issue:

1. **Enable Maximum Debugging:**
```bash
export POE_API_KEY="your-key"
CLAUDEDEBUG=1 ./dist/index.js --model poe/grok-4 --debug --log-level debug "Use calculator: 2+2"
```

2. **Monitor Logs in Real-time:**
```bash
tail -f logs/claudish_*.log | grep -E "tool_calls|Tool|content_block|Poe API"
```

3. **Test Direct HTTP Requests:**
```bash
curl -X POST http://localhost:3000/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"poe/grok-4","max_tokens":100,"messages":[{"role":"user","content":"Calculate 2+2"}],"tools":[{"name":"calculator","description":"Calculate"}],"stream":true}'
```

4. **Compare with Working Handler:**
```bash
export OPENROUTER_API_KEY="your-key"
./dist/index.js --model openai/gpt-4 --debug "Use calculator: 2+2"
```

## Expected Outcomes

This test suite should definitively identify:
- ✅ Whether tool calls are being received from Poe API
- ✅ Whether transformChunk is processing them correctly
- ✅ Whether Claude-compatible SSE events are generated
- ✅ Whether the complete tool call lifecycle works
- ✅ Exactly where in the pipeline issues occur

The comprehensive diagnostic output will provide actionable information to fix any root causes of tool call failures.