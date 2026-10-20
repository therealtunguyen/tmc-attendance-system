import type { OpenResult, TurnstileClient } from './turnstile-client.js';

/** Real TCS API. 1 s timeout, no retry (ADR-3). */
export class TcsHttpClient implements TurnstileClient {
  constructor(
    private baseUrl: string,
    private timeoutMs = 1000,
  ) {}

  async open(turnstileId: string): Promise<OpenResult> {
    try {
      const res = await fetch(
        `${this.baseUrl}/turnstiles/${encodeURIComponent(turnstileId)}/open`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      return res.ok ? 'OPENED' : 'ERROR';
    } catch (err) {
      return err instanceof Error && err.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR';
    }
  }
}
