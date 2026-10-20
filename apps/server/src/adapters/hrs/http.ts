import type { HrsClient, MonthlyBatch, SendResult } from './hrs-client.js';

/** Real HRS API. Network errors throw so the export job can retry (FR-4.6). */
export class HrsHttpClient implements HrsClient {
  constructor(private baseUrl: string) {}

  async send(batch: MonthlyBatch): Promise<SendResult> {
    const res = await fetch(`${this.baseUrl}/attendance-batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    return res.ok ? 'ACCEPTED' : 'REJECTED';
  }
}
