import type { HrsClient, MonthlyBatch, SendResult } from './hrs-client.js';

/**
 * Real HRS API (FR-4.6, ADR-6). Status mapping:
 * - 2xx -> 'ACCEPTED'
 * - 408, 429 and every 5xx -> throws (temporary, so the export job retries)
 * - any other status (4xx) -> 'REJECTED' (permanent, no retry)
 * Network errors and a missing answer within `timeoutMs` also throw.
 */
export class HrsHttpClient implements HrsClient {
  constructor(
    private baseUrl: string,
    private timeoutMs = 30_000,
  ) {}

  async send(batch: MonthlyBatch): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/attendance-batches`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`HRS did not answer within ${this.timeoutMs} ms`, { cause: err });
      }
      throw err;
    }
    if (res.ok) return 'ACCEPTED';
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new Error(`HRS answered ${res.status}`);
    }
    return 'REJECTED';
  }
}
