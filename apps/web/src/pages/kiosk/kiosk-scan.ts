export const SCAN_DEADLINE_MS = 1_800;
export const RESULT_DISPLAY_MS = 3_000;

export interface ScanRequest {
  gateId: string;
  token: string;
}

export const GATE_ID_RE = /^[\w-]{1,64}$/;

export interface Decision {
  eventId: string;
  reason?: string;
  result: 'GRANTED' | 'DENIED';
  firstName?: string;
}

export type KioskView =
  | { kind: 'idle' }
  | { kind: 'processing' }
  | { kind: 'result'; decision: Decision }
  | { kind: 'unknown' };

export type ScanTransport = (request: ScanRequest, signal: AbortSignal) => Promise<Decision>;

/** The edge owns validation, attendance and TCS. Never retry a physical-open request. */
export const fetchScan: ScanTransport = async (request, signal) => {
  const response = await fetch(import.meta.env.VITE_KIOSK_SCAN_URL || '/api/kiosk/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Scan API unavailable');
  const body: unknown = await response.json();
  const decision = body as Partial<Decision> | null;
  if (
    (decision?.result !== 'GRANTED' && decision?.result !== 'DENIED') ||
    typeof decision.eventId !== 'string' ||
    !decision.eventId.trim() ||
    (decision.reason !== undefined && typeof decision.reason !== 'string') ||
    (decision.firstName !== undefined && typeof decision.firstName !== 'string') ||
    (decision.result === 'GRANTED' && !decision.firstName?.trim())
  ) {
    throw new Error('Invalid scan response');
  }
  return {
    result: decision.result,
    firstName: decision.firstName,
    eventId: decision.eventId,
    reason: decision.reason,
  };
};

/** One scan at a time, including the result display; late responses cannot replace a newer scan. */
export class KioskScanner {
  private locked = false;
  private stopped = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private reset?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;

  constructor(
    private gateId: string,
    private changed: (view: KioskView) => void,
    private transport: ScanTransport = fetchScan,
  ) {}

  async scan(raw: string): Promise<void> {
    const token = raw.trim();
    if (this.stopped || this.locked || !token || !GATE_ID_RE.test(this.gateId)) return;
    this.locked = true;
    const abort = new AbortController();
    this.abort = abort;
    let settled = false;
    const finish = (view: KioskView) => {
      if (settled || this.stopped) return;
      settled = true;
      clearTimeout(this.deadline);
      this.changed(view);
      this.reset = setTimeout(() => {
        this.locked = false;
        this.changed({ kind: 'idle' });
      }, RESULT_DISPLAY_MS);
    };
    this.changed({ kind: 'processing' });
    this.deadline = setTimeout(() => {
      // Aborting the browser request does not undo an open already performed by the edge.
      finish({ kind: 'unknown' });
      abort.abort();
    }, SCAN_DEADLINE_MS);
    try {
      const decision = await this.transport({ gateId: this.gateId, token }, abort.signal);
      finish({ kind: 'result', decision });
    } catch {
      finish({ kind: 'unknown' });
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.deadline);
    clearTimeout(this.reset);
    this.abort?.abort();
  }
}
