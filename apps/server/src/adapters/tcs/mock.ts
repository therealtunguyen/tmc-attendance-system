import type { OpenResult, TurnstileClient } from './turnstile-client.js';

export type MockTurnstileMode = 'open' | 'fail' | 'slow';

/** In-process TCS stand-in. `slow` waits out the timeout, like a TCS that never answers. */
export class MockTurnstile implements TurnstileClient {
  constructor(
    public mode: MockTurnstileMode = 'open',
    private timeoutMs = 1000,
  ) {}

  async open(): Promise<OpenResult> {
    if (this.mode === 'open') return 'OPENED';
    if (this.mode === 'fail') return 'ERROR';
    await new Promise((resolve) => setTimeout(resolve, this.timeoutMs));
    return 'TIMEOUT';
  }
}
