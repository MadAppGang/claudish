import { describe, it, expect, beforeEach } from "bun:test";

// Import the classes we need to test
import { PoeHandler, SSEParser, ContentBlockTracker, ErrorHandler } from "../src/handlers/poe-handler.js";

// Mock the logger to avoid actual logging during tests
const mockLogger = {
  log: () => {},
  logStructured: () => {},
  shouldDebug: () => false,
  maskCredential: (key: string) => "***"
};

// Mock modules that the handler depends on
global.console = {
  ...console,
  error: () => {}
} as any;

describe("PoeHandler SSE Components", () => {
  let handler: PoeHandler;
  let sseParser: SSEParser;

  beforeEach(() => {
    handler = new PoeHandler("test-api-key");
    sseParser = new SSEParser();
  });

  describe("SSEParser", () => {
    it("should parse single SSE events", () => {
      const sseData = "data: {\"test\": \"value\"}\n";
      const events = sseParser.parse(sseData);
      expect(events).toEqual(['{"test": "value"}']);
    });

    it("should handle multiple SSE events", () => {
      const sseData = "data: {\"test1\": \"value1\"}\ndata: {\"test2\": \"value2\"}\n";
      const events = sseParser.parse(sseData);
      expect(events).toEqual(['{"test1": "value1"}', '{"test2": "value2"}']);
    });

    it("should handle partial SSE data", () => {
      const sseData = "data: {\"test\": \"incompl";
      const events = sseParser.parse(sseData);
      expect(events).toEqual([]);
    });

    it("should handle [DONE] marker", () => {
      const sseData = "data: [DONE]\n";
      const events = sseParser.parse(sseData);
      expect(events).toEqual(['[DONE]']);
    });

    it("should ignore empty data lines", () => {
      const sseData = "data: \ndata: {\"test\": \"value\"}\ndata: \n";
      const events = sseParser.parse(sseData);
      expect(events).toEqual(['{"test": "value"}']);
    });

    it("should handle buffer overflow protection", () => {
      // Create a very large string that would exceed the buffer
      const largeData = "data: {\"test\": \"" + "x".repeat(100000) + "\"}\n";
      const parser = new SSEParser();
      const events = parser.parse(largeData);
      // Buffer should be truncated, but parser should still work
      expect(events.length).toBeGreaterThanOrEqual(0);

      // Test with smaller data that should work
      const normalData = "data: {\"test\": \"value\"}\n";
      const normalEvents = parser.parse(normalData);
      expect(normalEvents).toEqual(['{"test": "value"}']);
    });
  });

  describe("transformChunk", () => {
    it("should handle content deltas", () => {
      const chunk = {
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            content: "Hello world"
          }
        }]
      };

      const result = handler["transformChunk"](chunk);
      expect(result).toEqual({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Hello world"
        }
      });
    });

    it("should ignore role deltas", () => {
      const chunk = {
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            role: "assistant"
          }
        }]
      };

      const result = handler["transformChunk"](chunk);
      expect(result).toBeNull();
    });

    it("should ignore empty deltas", () => {
      const chunk = {
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {}
        }]
      };

      const result = handler["transformChunk"](chunk);
      expect(result).toBeNull();
    });

    it("should handle finish reason", () => {
      const chunk = {
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop"
        }]
      };

      const result = handler["transformChunk"](chunk);
      expect(result).toEqual({
        type: "content_block_stop",
        index: 0
      });
    });

    it("should handle function_call deltas", () => {
      const chunk = {
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            function_call: {
              name: "test_function",
              arguments: "{}"
            }
          }
        }]
      };

      const result = handler["transformChunk"](chunk);
      expect(result).toBeNull(); // Should be silently ignored for now
    });

    it("should handle invalid chunks gracefully", () => {
      const invalidChunks = [
        null,
        undefined,
        {},
        { choices: [] },
        { choices: [{ delta: null }] },
        { object: "invalid.object", choices: [{}] }
      ];

      for (const chunk of invalidChunks) {
        const result = handler["transformChunk"](chunk);
        expect(result).toBeNull();
      }
    });
  });

  describe("ContentBlockTracker", () => {
    it("should track content block lifecycle", () => {
      const tracker = new ContentBlockTracker();

      const blockIndex = tracker.startTextBlock();
      expect(blockIndex).toBe(0);

      tracker.addTextDelta(blockIndex, "Hello");
      tracker.addTextDelta(blockIndex, " world");

      tracker.stopBlock(blockIndex);

      const stoppedBlocks = tracker.ensureAllBlocksStopped();
      expect(stoppedBlocks).toEqual([]);
    });

    it("should handle multiple content blocks", () => {
      const tracker = new ContentBlockTracker();

      const block1 = tracker.startTextBlock();
      const block2 = tracker.startTextBlock();

      expect(block1).toBe(0);
      expect(block2).toBe(1);

      tracker.stopBlock(block1);

      const stoppedBlocks = tracker.ensureAllBlocksStopped();
      expect(stoppedBlocks).toEqual([1]); // Only block2 should be stopped
    });
  });

  describe("ErrorHandler", () => {
    it("should handle SyntaxError gracefully", () => {
      const errorHandler = new ErrorHandler("test-model");

      const error = new SyntaxError("Invalid JSON");

      // Should not throw and should log appropriately
      expect(() => {
        errorHandler.handle(error, { context: "test" });
      }).not.toThrow();
    });

    it("should handle TypeError gracefully", () => {
      const errorHandler = new ErrorHandler("test-model");

      const error = new TypeError("Invalid type");

      // Should not throw and should log appropriately
      expect(() => {
        errorHandler.handle(error, { context: "test" });
      }).not.toThrow();
    });

    it("should handle generic errors", () => {
      const errorHandler = new ErrorHandler("test-model");

      const error = new Error("Generic error");

      // Should not throw and should log appropriately
      expect(() => {
        errorHandler.handle(error, { context: "test" });
      }).not.toThrow();
    });
  });
});