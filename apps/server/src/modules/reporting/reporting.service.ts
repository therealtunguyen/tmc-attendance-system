import type { HrsClient } from '../../adapters/hrs/hrs-client.js';
import { todo } from '../../shared/errors.js';
import type { ConfigReader } from '../admin/index.js';
import type { AttendanceQuery } from '../attendance/index.js';
import type { AuditLog } from '../iam/index.js';
import type { ReportingRepo } from './reporting.repo.js';

export type AlertKind = 'EXPORT_FAILED' | 'GATE_OFFLINE';

export interface Notifier {
  alert(kind: AlertKind, message: string): Promise<void>;
}

/** Reports, CSV, access log, monthly HR export with retry, alerts (FR-4.1 to FR-4.6). */
export class ReportingService implements Notifier {
  constructor(
    private repo: ReportingRepo,
    private attendance: AttendanceQuery,
    private config: ConfigReader,
    private hrs: HrsClient,
    private audit: AuditLog,
  ) {}

  async alert(): Promise<void> {
    return todo();
  }

  async runMonthlyExport(): Promise<void> {
    return todo();
  }
}
