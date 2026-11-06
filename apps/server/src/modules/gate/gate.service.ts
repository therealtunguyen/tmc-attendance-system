import type { TurnstileClient } from '../../adapters/tcs/turnstile-client.js';
import type { EdgeHeartbeat } from '../../shared/contracts/edge.js';
import { todo } from '../../shared/errors.js';
import type { ConfigReader } from '../admin/index.js';
import type { AttendanceRecorder } from '../attendance/index.js';
import type { QrValidation } from '../employee-qr/index.js';
import type { AuditLog } from '../iam/index.js';
import type { Notifier } from '../reporting/index.js';
import type { GateRepo } from './gate.repo.js';

export interface ScanRequest {
  eventId: string;
  gateId: string;
  token: string;
}

export interface Decision {
  result: 'GRANTED' | 'DENIED';
  firstName?: string;
}

/** Gate registry, scan flow, kiosk API, heartbeat, manual override (FR-2.x). */
export class GateService {
  constructor(
    private repo: GateRepo,
    private qr: QrValidation,
    private recorder: AttendanceRecorder,
    private turnstile: TurnstileClient,
    private config: ConfigReader,
    private notifier: Notifier,
    private audit: AuditLog,
  ) {}

  /** validate -> record (commit) -> open -> setOutcome. See report, gate scan sequence diagram. */
  async scan(_req: ScanRequest): Promise<Decision> {
    return todo();
  }

  async heartbeat(_gateId: string): Promise<void> {
    return todo();
  }

  /** Marks the edge online; the edge is offline when these stop (ADR-9, FR-2.6). */
  async edgeHeartbeat(_hb: EdgeHeartbeat): Promise<void> {
    return todo();
  }
}
