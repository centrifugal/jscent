/** The options of one call. */
export interface CallOptions {
  /**
   * Milliseconds bounding the call - connecting, sending, the reply's headers
   * and body: requestTimeout when unset.
   */
  timeout?: number;
  /** Aborts the call; it then throws the signal's reason, as fetch does. */
  signal?: AbortSignal;
}
