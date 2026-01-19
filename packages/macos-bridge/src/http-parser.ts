/**
 * HTTP/1.1 Request Parser
 *
 * Buffers incoming data until a complete HTTP request is received,
 * then parses headers and body for routing decisions.
 */

/**
 * Parsed HTTP request structure
 */
export interface ParsedHTTPRequest {
  method: string;
  path: string;
  httpVersion: string;
  headers: Record<string, string>;
  body: Buffer;
  raw: Buffer; // Full request for passthrough
}

/**
 * HTTP/1.1 request parser with buffering support
 */
export class HTTPRequestParser {
  private buffer: Buffer[] = [];
  private headersParsed = false;
  private headers: Record<string, string> = {};
  private requestLine: { method: string; path: string; httpVersion: string } | null = null;
  private contentLength: number | null = null;
  private isChunked = false;
  private bodyBytesReceived = 0;
  private headerEndIndex = -1;

  /**
   * Feed a chunk of data to the parser
   */
  feed(chunk: Buffer): void {
    this.buffer.push(chunk);

    // Try to parse headers if not yet parsed
    if (!this.headersParsed) {
      this.tryParseHeaders();
    }
  }

  /**
   * Try to parse HTTP headers from buffered data
   */
  private tryParseHeaders(): void {
    const combined = Buffer.concat(this.buffer);

    // Find header end marker: \r\n\r\n
    const headerEnd = combined.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return; // Headers not complete yet
    }

    this.headerEndIndex = headerEnd;

    // Extract header section
    const headerSection = combined.subarray(0, headerEnd).toString("utf8");
    const lines = headerSection.split("\r\n");

    // Parse request line (first line)
    const requestLine = lines[0];
    const match = requestLine.match(
      /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)\s+(HTTP\/\d\.\d)$/
    );
    if (!match) {
      throw new Error(`Invalid HTTP request line: ${requestLine}`);
    }

    this.requestLine = {
      method: match[1],
      path: match[2],
      httpVersion: match[3],
    };

    // Parse headers
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const name = line.slice(0, colonIdx).toLowerCase().trim();
      const value = line.slice(colonIdx + 1).trim();
      this.headers[name] = value;
    }

    // Determine body length
    const contentLengthHeader = this.headers["content-length"];
    if (contentLengthHeader) {
      this.contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isNaN(this.contentLength)) {
        this.contentLength = 0;
      }
    }

    // Check for chunked encoding
    const transferEncoding = this.headers["transfer-encoding"];
    if (transferEncoding?.toLowerCase().includes("chunked")) {
      this.isChunked = true;
    }

    this.headersParsed = true;

    // Calculate body bytes received so far
    const bodyStart = headerEnd + 4;
    this.bodyBytesReceived = combined.length - bodyStart;
  }

  /**
   * Check if the complete HTTP request has been received
   */
  isComplete(): boolean {
    if (!this.headersParsed) {
      return false;
    }

    // For chunked encoding, look for final chunk marker: 0\r\n\r\n
    if (this.isChunked) {
      const combined = Buffer.concat(this.buffer);
      const bodyStart = this.headerEndIndex + 4;
      const bodySection = combined.subarray(bodyStart);

      // Look for the end of chunked encoding: \r\n0\r\n\r\n
      const endMarker = bodySection.indexOf("\r\n0\r\n\r\n");
      if (endMarker !== -1) {
        return true;
      }

      // Also accept just 0\r\n\r\n at the end
      const simpleEnd = bodySection.toString("utf8").endsWith("0\r\n\r\n");
      return simpleEnd;
    }

    // For Content-Length, check if we have all body bytes
    if (this.contentLength !== null) {
      return this.bodyBytesReceived >= this.contentLength;
    }

    // No body expected (GET, DELETE, etc.)
    return true;
  }

  /**
   * Parse and return the complete HTTP request
   * Returns null if request is not complete yet
   */
  parse(): ParsedHTTPRequest | null {
    if (!this.isComplete()) {
      return null;
    }

    if (!this.requestLine) {
      throw new Error("Request line not parsed");
    }

    const combined = Buffer.concat(this.buffer);
    const bodyStart = this.headerEndIndex + 4;
    let body: Buffer;

    // Extract body
    if (this.isChunked) {
      // Decode chunked transfer encoding
      body = this.decodeChunkedBody(combined.subarray(bodyStart));
    } else if (this.contentLength !== null && this.contentLength > 0) {
      body = combined.subarray(bodyStart, bodyStart + this.contentLength);
    } else {
      body = Buffer.alloc(0);
    }

    return {
      method: this.requestLine.method,
      path: this.requestLine.path,
      httpVersion: this.requestLine.httpVersion,
      headers: this.headers,
      body,
      raw: combined,
    };
  }

  /**
   * Decode chunked transfer encoding
   */
  private decodeChunkedBody(chunkedData: Buffer): Buffer {
    const chunks: Buffer[] = [];
    let pos = 0;
    const str = chunkedData.toString("utf8");

    while (pos < str.length) {
      // Find chunk size line
      const lineEnd = str.indexOf("\r\n", pos);
      if (lineEnd === -1) break;

      const chunkSizeLine = str.slice(pos, lineEnd);
      const chunkSize = Number.parseInt(chunkSizeLine, 16);

      // Zero-size chunk marks the end
      if (chunkSize === 0) break;

      // Extract chunk data
      const chunkStart = lineEnd + 2;
      const chunkEnd = chunkStart + chunkSize;
      chunks.push(Buffer.from(str.slice(chunkStart, chunkEnd)));

      // Move past chunk data and trailing \r\n
      pos = chunkEnd + 2;
    }

    return Buffer.concat(chunks);
  }

  /**
   * Reset parser state for next request
   */
  reset(): void {
    this.buffer = [];
    this.headersParsed = false;
    this.headers = {};
    this.requestLine = null;
    this.contentLength = null;
    this.isChunked = false;
    this.bodyBytesReceived = 0;
    this.headerEndIndex = -1;
  }

  /**
   * Get current headers (even if request not complete)
   */
  getHeaders(): Record<string, string> {
    return this.headers;
  }

  /**
   * Get current request line (even if request not complete)
   */
  getRequestLine(): { method: string; path: string; httpVersion: string } | null {
    return this.requestLine;
  }
}
