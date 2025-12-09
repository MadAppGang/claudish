/**
 * SSE Event Analyzer for debugging tool call flows
 */
export class SSEAnalyzer {
  private events: any[] = [];
  private diagnostics: any = {
    toolCallEvents: [],
    textEvents: [],
    errorEvents: [],
    timing: [],
    blockTracking: []
  };

  /**
   * Parse SSE data and extract events
   */
  parseSSEData(data: string): void {
    const lines = data.split('\n');
    let currentEvent: any = {};
    let eventData = '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent.type = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        eventData = line.substring(5).trim();
        if (eventData && eventData !== '[DONE]') {
          try {
            currentEvent.data = JSON.parse(eventData);
          } catch (e) {
            currentEvent.rawData = eventData;
          }
        }
      } else if (line === '') {
        // Empty line signifies end of event
        if (currentEvent.type || currentEvent.data) {
          this.addEvent(currentEvent);
          currentEvent = {};
          eventData = '';
        }
      }
    }
  }

  /**
   * Add an event to the analysis
   */
  private addEvent(event: any): void {
    event.timestamp = Date.now();
    this.events.push(event);
    this.categorizeEvent(event);
  }

  /**
   * Categorize events for diagnostic analysis
   */
  private categorizeEvent(event: any): void {
    const { type, data } = event;

    if (!data) return;

    // Tool call related events
    if (type === 'content_block_start' && data.content_block?.type === 'tool_use') {
      this.diagnostics.toolCallEvents.push({
        type: 'tool_use_start',
        toolId: data.content_block.id,
        toolName: data.content_block.name,
        index: data.index,
        timestamp: event.timestamp
      });
    }

    if (type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
      this.diagnostics.toolCallEvents.push({
        type: 'tool_arguments',
        partialJson: data.delta.partial_json,
        index: data.index,
        timestamp: event.timestamp
      });
    }

    if (type === 'content_block_stop') {
      this.diagnostics.toolCallEvents.push({
        type: 'tool_use_stop',
        index: data.index,
        timestamp: event.timestamp
      });
    }

    // Text events
    if (type === 'content_block_start' && data.content_block?.type === 'text') {
      this.diagnostics.textEvents.push({
        type: 'text_start',
        index: data.index,
        timestamp: event.timestamp
      });
    }

    if (type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      this.diagnostics.textEvents.push({
        type: 'text_delta',
        text: data.delta.text,
        index: data.index,
        timestamp: event.timestamp
      });
    }

    // Error events
    if (type === 'error') {
      this.diagnostics.errorEvents.push({
        error: data.error,
        timestamp: event.timestamp
      });
    }

    // Timing analysis
    this.diagnostics.timing.push({
      eventType: type,
      timestamp: event.timestamp,
      relativeTime: event.timestamp - (this.diagnostics.timing[0]?.timestamp || event.timestamp)
    });
  }

  /**
   * Analyze tool call flow and identify issues
   */
  analyzeToolCallFlow(): any {
    const toolEvents = this.diagnostics.toolCallEvents;
    const analysis = {
      hasToolCalls: toolEvents.length > 0,
      toolCallCount: 0,
      completeToolCalls: 0,
      incompleteToolCalls: [],
      timingIssues: [],
      formatIssues: []
    };

    // Count tool calls and check completeness
    const toolCalls = new Map();

    for (const event of toolEvents) {
      if (event.type === 'tool_use_start') {
        toolCalls.set(event.index, {
          started: true,
          hasArguments: false,
          stopped: false,
          toolId: event.toolId,
          toolName: event.toolName
        });
        analysis.toolCallCount++;
      } else if (event.type === 'tool_arguments') {
        const toolCall = toolCalls.get(event.index);
        if (toolCall) {
          toolCall.hasArguments = true;
        }
      } else if (event.type === 'tool_use_stop') {
        const toolCall = toolCalls.get(event.index);
        if (toolCall) {
          toolCall.stopped = true;
        }
      }
    }

    // Check for incomplete tool calls
    for (const [index, toolCall] of toolCalls) {
      if (toolCall.started && toolCall.stopped && toolCall.hasArguments) {
        analysis.completeToolCalls++;
      } else {
        analysis.incompleteToolCalls.push({
          index,
          ...toolCall,
          issue: this.getToolCallIssue(toolCall)
        });
      }
    }

    // Check timing
    const timeSpan = this.diagnostics.timing.length > 1
      ? this.diagnostics.timing[this.diagnostics.timing.length - 1].timestamp - this.diagnostics.timing[0].timestamp
      : 0;

    if (timeSpan > 10000) { // More than 10 seconds
      analysis.timingIssues.push('Response took longer than expected');
    }

    return analysis;
  }

  /**
   * Identify specific issues with tool calls
   */
  private getToolCallIssue(toolCall: any): string {
    if (!toolCall.started) return 'Tool call never started';
    if (!toolCall.hasArguments) return 'Tool call missing arguments';
    if (!toolCall.stopped) return 'Tool call never completed';
    return 'Unknown issue';
  }

  /**
   * Generate diagnostic report
   */
  generateReport(): any {
    const toolCallAnalysis = this.analyzeToolCallFlow();
    const textAnalysis = this.analyzeTextFlow();

    return {
      summary: {
        totalEvents: this.events.length,
        hasToolCalls: toolCallAnalysis.hasToolCalls,
        hasText: textAnalysis.hasText,
        hasErrors: this.diagnostics.errorEvents.length > 0,
        duration: this.getEventDuration()
      },
      toolCalls: toolCallAnalysis,
      textFlow: textAnalysis,
      errors: this.diagnostics.errorEvents,
      recommendations: this.generateRecommendations(toolCallAnalysis, textAnalysis)
    };
  }

  /**
   * Analyze text flow
   */
  private analyzeTextFlow(): any {
    const textEvents = this.diagnostics.textEvents;

    return {
      hasText: textEvents.length > 0,
      textBlocks: textEvents.filter(e => e.type === 'text_start').length,
      totalTextDeltas: textEvents.filter(e => e.type === 'text_delta').length
    };
  }

  /**
   * Get total duration of events
   */
  private getEventDuration(): number {
    if (this.events.length < 2) return 0;
    return this.events[this.events.length - 1].timestamp - this.events[0].timestamp;
  }

  /**
   * Generate debugging recommendations
   */
  private generateRecommendations(toolAnalysis: any, textAnalysis: any): string[] {
    const recommendations: string[] = [];

    if (!toolAnalysis.hasToolCalls) {
      recommendations.push('No tool calls detected - check if Poe model supports tools or prompt contains tool request');
    }

    if (toolAnalysis.incompleteToolCalls.length > 0) {
      recommendations.push(`Found ${toolAnalysis.incompleteToolCalls.length} incomplete tool calls`);
      for (const incomplete of toolAnalysis.incompleteToolCalls) {
        recommendations.push(`- Tool call at index ${incomplete.index}: ${incomplete.issue}`);
      }
    }

    if (toolAnalysis.toolCallCount > 0 && toolAnalysis.completeToolCalls === 0) {
      recommendations.push('Tool calls detected but none completed - check SSE event format');
    }

    if (this.diagnostics.errorEvents.length > 0) {
      recommendations.push('Errors detected during stream - check proxy server logs');
    }

    return recommendations;
  }

  /**
   * Reset analyzer for new test
   */
  reset(): void {
    this.events = [];
    this.diagnostics = {
      toolCallEvents: [],
      textEvents: [],
      errorEvents: [],
      timing: [],
      blockTracking: []
    };
  }

  /**
   * Get raw events for detailed debugging
   */
  getRawEvents(): any[] {
    return this.events;
  }

  /**
   * Export events for external analysis
   */
  exportEvents(): string {
    return JSON.stringify({
      events: this.events,
      diagnostics: this.diagnostics,
      report: this.generateReport()
    }, null, 2);
  }
}