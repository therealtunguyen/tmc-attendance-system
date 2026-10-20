export interface MonthlyBatch {
  month: string; // YYYY-MM
  rows: unknown[];
}

export type SendResult = 'ACCEPTED' | 'REJECTED';

export interface HrsClient {
  send(batch: MonthlyBatch): Promise<SendResult>;
}
