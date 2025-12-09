import { createServer } from 'http';
import { Server } from 'socket.io';

/**
 * Mock Poe API Server for testing tool call scenarios
 */
export class MockPoeApiServer {
  private server: any;
  private port: number;
  private responses: any[] = [];

  constructor(port: number = 3001) {
    this.port = port;
  }

  /**
   * Add a custom response to the mock queue
   */
  addResponse(response: any): void {
    this.responses.push(response);
  }

  /**
   * Get predefined tool call response
   */
  getToolCallResponse(toolName: string, args: any) {
    return {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: `call_${Date.now()}`,
            function: {
              name: toolName,
              arguments: JSON.stringify(args)
            }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      }
    };
  }

  /**
   * Get streaming tool call response chunks
   */
  getStreamingToolCallResponse(toolName: string, args: any) {
    const argString = JSON.stringify(args);
    const chunks = [];

    // First chunk: tool call start
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: `call_${Date.now()}`,
            function: {
              name: toolName,
              arguments: argString.substring(0, Math.ceil(argString.length / 2))
            }
          }]
        }
      }]
    });

    // Second chunk: tool call completion
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: argString.substring(Math.ceil(argString.length / 2))
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    });

    return chunks;
  }

  /**
   * Get text response (no tool calls)
   */
  getTextResponse(text: string) {
    return {
      choices: [{
        delta: {
          content: text
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 10,
        total_tokens: 15
      }
    };
  }

  /**
   * Start the mock server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const requestData = JSON.parse(body);

            // Set CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

            if (req.method === 'OPTIONS') {
              res.writeHead(200);
              res.end();
              return;
            }

            if (req.url === '/v1/chat/completions' && req.method === 'POST') {
              // Check if request contains tools
              const hasTools = requestData.tools && requestData.tools.length > 0;

              // Get next response from queue or generate default
              const response = this.responses.length > 0
                ? this.responses.shift()
                : this.getDefaultResponse(hasTools, requestData);

              if (requestData.stream) {
                // Streaming response
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive'
                });

                const chunks = Array.isArray(response) ? response : [response];

                chunks.forEach((chunk, index) => {
                  setTimeout(() => {
                    if (chunk.choices?.[0]?.finish_reason === 'tool_calls') {
                      // Tool call completion
                      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                      res.write('data: [DONE]\n\n');
                    } else {
                      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                  }, index * 50); // Small delay between chunks
                });

                setTimeout(() => {
                  res.end();
                }, chunks.length * 50 + 100);
              } else {
                // Non-streaming response
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
              }
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Not found' }));
            }
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      });

      this.server.listen(this.port, () => {
        console.log(`Mock Poe API server started on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Get default response based on request
   */
  private getDefaultResponse(hasTools: boolean, requestData: any) {
    if (hasTools) {
      // Default tool call response
      return this.getToolCallResponse('default_tool', {
        message: 'Default tool response',
        input: requestData.messages?.[0]?.content || 'No content'
      });
    } else {
      // Default text response
      return this.getTextResponse('This is a default text response from the mock Poe API.');
    }
  }

  /**
   * Stop the mock server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('Mock Poe API server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * Mock API scenarios for testing
 */
export const mockScenarios = {
  // Tool call scenarios
  simpleToolCall: {
    toolName: 'calculator',
    args: { operation: 'add', a: 5, b: 3 }
  },

  weatherToolCall: {
    toolName: 'get_weather',
    args: { location: 'San Francisco', unit: 'fahrenheit' }
  },

  // Error scenarios
  malformedToolCall: {
    toolName: '',
    args: null
  },

  // Text-only scenarios
  textOnlyResponse: {
    text: 'I cannot use tools, but I can help you with text-based responses.'
  }
};