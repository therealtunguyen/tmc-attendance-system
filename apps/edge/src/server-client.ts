// Typed wrappers for the server's edge API (ADR-9).
// Never throws on network errors — callers check the returned error shape.
import type {
  EdgeHeartbeat,
  EdgeSnapshot,
  PushEventsRequest,
  PushEventsResponse,
} from '../../server/src/shared/contracts/edge.js';

export type FetchResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

const json = async <T>(res: Response): Promise<FetchResult<T>> => {
  if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
  return { ok: true, data: (await res.json()) as T };
};

export class ServerClient {
  constructor(
    private baseUrl: string,
    private edgeToken = '',
    private timeoutMs = 10_000,
  ) {}

  private signal() {
    return AbortSignal.timeout(this.timeoutMs);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.edgeToken ? { ...extra, authorization: `Bearer ${this.edgeToken}` } : extra;
  }

  async getSnapshot(edgeId: string): Promise<FetchResult<EdgeSnapshot>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/api/edge/snapshot?edgeId=${encodeURIComponent(edgeId)}`,
        { headers: this.headers(), signal: this.signal() },
      );
      return json<EdgeSnapshot>(res);
    } catch (err) {
      return { ok: false, status: 0, error: String(err) };
    }
  }

  async pushEvents(req: PushEventsRequest): Promise<FetchResult<PushEventsResponse>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/edge/events`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(req),
        signal: this.signal(),
      });
      return json<PushEventsResponse>(res);
    } catch (err) {
      return { ok: false, status: 0, error: String(err) };
    }
  }

  async heartbeat(hb: EdgeHeartbeat): Promise<FetchResult<null>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/edge/heartbeat`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(hb),
        signal: this.signal(),
      });
      if (res.status === 204) return { ok: true, data: null };
      return { ok: false, status: res.status, error: await res.text() };
    } catch (err) {
      return { ok: false, status: 0, error: String(err) };
    }
  }
}
