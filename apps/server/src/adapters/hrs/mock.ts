import type { HrsClient, SendResult } from './hrs-client.js';

/** In-process HRS stand-in: throws `failTimes` times, then answers with `result`. */
export class MockHrs implements HrsClient {
  constructor(
    private result: SendResult = 'ACCEPTED',
    private failTimes = 0,
  ) {}

  async send(): Promise<SendResult> {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('MockHrs: simulated failure');
    }
    return this.result;
  }
}
