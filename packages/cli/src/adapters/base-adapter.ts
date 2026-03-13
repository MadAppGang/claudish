/**
 * BaseAdapter — common base for FormatAdapter and ModelAdapter.
 *
 * Holds the model ID and shared method signatures for capabilities
 * that both axes need to express: context window, vision support,
 * request post-processing, and lifecycle reset.
 *
 * Return types use `| undefined` so that ModelAdapter can signal
 * "no opinion" while FormatAdapter narrows to definite values.
 */

export abstract class BaseAdapter {
  protected modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  abstract getName(): string;

  /**
   * Post-process the request payload before sending.
   * FormatAdapter: tool name truncation. ModelAdapter: param mapping.
   */
  prepareRequest(request: any, _originalRequest: any): any {
    return request;
  }

  /**
   * Context window size for this adapter's model/format.
   * undefined = no opinion (defer to the other adapter).
   */
  getContextWindow(): number | undefined {
    return undefined;
  }

  /**
   * Whether vision content is supported.
   * undefined = no opinion (defer to the other adapter).
   */
  supportsVision(): boolean | undefined {
    return undefined;
  }

  /**
   * Reset internal state between requests.
   */
  reset(): void {
    // No-op by default
  }
}
