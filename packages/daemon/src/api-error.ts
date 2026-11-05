import type { ErrorResponse } from '@nanachi/shared';

/**
 * HTTP error with a stable code. The server's error handler replies with `{ error, details? }` and this status.
 * The thrower picks the code; the route does not build the response itself. `message` is for logs only and is
 * never sent to the client.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorResponse {
    return this.details === undefined ? { error: this.code } : { error: this.code, details: this.details };
  }
}
