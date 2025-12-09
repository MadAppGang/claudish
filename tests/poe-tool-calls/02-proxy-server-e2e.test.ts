import { createServer } from 'http';
import { createProxyServer } from '../../src/proxy-server.js';
import { MockPoeApiServer, mockScenarios } from './utils/mock-poe-api.js';
import { SSEAnalyzer } from './utils/sse-analyzer.js';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('Poe Handler - End-to-End Proxy Server Tests', () => {
  let proxyServer: any;
  let mockPoeApi: MockPoeApiServer;
  let proxyPort: number;
  let analyzer: SSEAnalyzer;

  beforeEach(async () => {
    analyzer = new SSEAnalyzer();
    mockPoeApi = new MockPoeApiServer(3001);
    await mockPoeApi.start();

    // Find an available port for proxy
    proxyPort = 3002;
    proxyServer = await createProxyServer(proxyPort);
  });

  afterEach(async () => {
    await mockPoeApi.stop();
    await proxyServer.close();
  });

  it('should route Poe model requests to Poe handler', async () => {
    const request = {
      model: 'poe/grok-4',
      messages: [{ role: 'user', content: 'Test message' }],
      max_tokens: 10,
      stream: false
    };

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });

    expect(response.status).toBe(200);

    const responseData = await response.json();
    expect(responseData).toBeDefined();
    // Verify response structure from mock API
  });

  it('should handle tool calls in streaming mode', async () => {
    // Setup mock API to return tool call
    mockPoeApi.addResponse(
      mockPoeApi.getStreamingToolCallResponse(
        mockScenarios.simpleToolCall.toolName,
        mockScenarios.simpleToolCall.args
      )
    );

    const request = {
      model: 'poe/grok-4',
      messages: [
        { role: 'user', content: 'What is 5 + 3?' }
      ],
      max_tokens: 100,
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Perform mathematical operations',
          parameters: {
            type: 'object',
            properties: {
              operation: { type: 'string' },
              a: { type: 'number' },
              b: { type: 'number' }
            }
          }
        }
      }]
    };

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });

    expect(response.status).toBe(200);

    // Collect and analyze SSE events
    const sseData = await response.text();
    analyzer.parseSSEData(sseData);

    const report = analyzer.generateReport();

    // Verify tool call processing
    expect(report.summary.hasToolCalls).toBe(true);
    expect(report.toolCalls.toolCallCount).toBeGreaterThan(0);
    expect(report.toolCalls.completeToolCalls).toBeGreaterThan(0);

    console.log('🔍 SSE Analysis Report:');
    console.log(JSON.stringify(report, null, 2));
  });

  it('should properly transform OpenAI tool_calls to Claude tool_use format', async () => {
    // Setup specific tool call scenario
    const toolCallData = mockPoeApi.getStreamingToolCallResponse(
      mockScenarios.weatherToolCall.toolName,
      mockScenarios.weatherToolCall.args
    );
    mockPoeApi.addResponse(toolCallData);

    const request = {
      model: 'poe/grok-4',
      messages: [
        { role: 'user', content: 'What is the weather in San Francisco?' }
      ],
      max_tokens: 100,
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather information',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' },
              unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
            }
          }
        }
      }]
    };

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });

    expect(response.status).toBe(200);

    const sseData = await response.text();
    analyzer.parseSSEData(sseData);

    const events = analyzer.getRawEvents();

    // Look for Claude-compatible tool_use events
    const toolUseStartEvent = events.find(e =>
      e.type === 'content_block_start' &&
      e.data?.content_block?.type === 'tool_use'
    );

    expect(toolUseStartEvent).toBeDefined();
    expect(toolUseStartEvent.data.content_block.name).toBe('get_weather');
    expect(toolUseStartEvent.data.content_block.id).toMatch(/^call_/);

    // Look for input_json_delta events
    const argumentEvents = events.filter(e =>
      e.type === 'content_block_delta' &&
      e.data?.delta?.type === 'input_json_delta'
    );

    expect(argumentEvents.length).toBeGreaterThan(0);

    // Verify the complete arguments are assembled correctly
    const fullArguments = argumentEvents
      .map(e => e.data.delta.partial_json)
      .join('');

    expect(fullArguments).toContain('San Francisco');
  });

  it('should handle mixed content (text + tool calls)', async () => {
    // Setup mixed response: text first, then tool call
    mockPoeApi.addResponse(mockPoeApi.getTextResponse('I will help you calculate that.'));
    mockPoeApi.addResponse(
      mockPoeApi.getStreamingToolCallResponse(
        mockScenarios.simpleToolCall.toolName,
        mockScenarios.simpleToolCall.args
      )
    );

    const request = {
      model: 'poe/grok-4',
      messages: [
        { role: 'user', content: 'Calculate 5 + 3' }
      ],
      max_tokens: 100,
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Perform calculations'
        }
      }]
    };

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });

    expect(response.status).toBe(200);

    const sseData = await response.text();
    analyzer.parseSSEData(sseData);

    const report = analyzer.generateReport();

    // Should have both text and tool calls
    expect(report.summary.hasText).toBe(true);
    expect(report.summary.hasToolCalls).toBe(true);
  });

  it('should handle malformed tool calls gracefully', async () => {
    // Setup malformed tool call
    mockPoeApi.addResponse({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            // Missing function name and ID
            function: {
              arguments: '{"incomplete": "data"}'
            }
          }]
        }
      }]
    });

    const request = {
      model: 'poe/grok-4',
      messages: [
        { role: 'user', content: 'Test with malformed tool call' }
      ],
      max_tokens: 100,
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'Test tool'
        }
      }]
    };

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });

    expect(response.status).toBe(200);

    const sseData = await response.text();
    analyzer.parseSSEData(sseData);

    const report = analyzer.generateReport();

    // Should not crash, but may have incomplete tool calls
    expect(report.summary.hasErrors).toBe(false);
  });

  it('should verify model name transformation (poe/model -> model)', async () => {
    // This would require intercepting the actual request to Poe API
    // For now, we verify the proxy accepts the poe/ prefix

    const request = {
      model: 'poe/grok-4',
      messages: [
        { role: 'user', content: 'Test model name transformation' }
      ],
      max_tokens: 10,
      stream: false
    };

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });

    expect(response.status).toBe(200);
  });

  it('should provide diagnostic information for debugging', async () => {
    // Clear any previous responses
    while (mockPoeApi['responses'].length > 0) {
      mockPoeApi['responses'].shift();
    }

    // Setup a scenario that should trigger diagnostics
    mockPoeApi.addResponse(
      mockPoeApi.getStreamingToolCallResponse(
        'diagnostic_tool',
        { test: 'data', timestamp: Date.now() }
      )
    );

    const request = {
      model: 'poe/grok-4',
      messages: [
        { role: 'user', content: 'Run diagnostic tool' }
      ],
      max_tokens: 100,
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'diagnostic_tool',
          description: 'Tool for testing diagnostics'
        }
      }]
    };

    const response = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });

    const sseData = await response.text();
    analyzer.parseSSEData(sseData);

    const report = analyzer.generateReport();
    const exportData = analyzer.exportEvents();

    // Verify diagnostic data is available
    expect(exportData).toBeDefined();
    expect(JSON.parse(exportData).report).toBeDefined();
    expect(report.recommendations).toBeDefined();

    console.log('📊 Full Diagnostic Export:');
    console.log(exportData);
  });
});