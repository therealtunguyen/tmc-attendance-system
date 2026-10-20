import { todo } from '../../shared/errors.js';
import type { DateRange, Scope } from '../../shared/types.js';
import type { AttendanceRepo } from './attendance.repo.js';

export type ScanOutcome = 'GRANTED' | 'DENIED';

export interface ScanEvent {
  eventId: string;
  employeeId: string | null;
  gateId: string;
  method: 'QR' | 'MANUAL';
  occurredAt: Date;
}

export interface DailyRecord {
  employeeId: string;
  day: Date;
  firstIn: Date | null;
  lastOut: Date | null;
  hours: number;
  missingPunch: boolean;
}

export interface AttendanceRecorder {
  /** Idempotent by eventId (FR-3.2). Returns false if the event already exists. */
  record(event: ScanEvent): Promise<boolean>;
  setOutcome(eventId: string, outcome: ScanOutcome): Promise<void>;
}

export interface AttendanceQuery {
  dailyRecords(range: DateRange, scope: Scope): Promise<DailyRecord[]>;
  history(employeeId: string): Promise<DailyRecord[]>;
  accessLog(range: DateRange): Promise<ScanEvent[]>;
}

/** Event store, daily records, missing punches, HR corrections (FR-1.6, FR-3.x). */
export class AttendanceService implements AttendanceRecorder, AttendanceQuery {
  constructor(private repo: AttendanceRepo) {}

  async record(): Promise<boolean> {
    return todo();
  }

  async setOutcome(): Promise<void> {
    return todo();
  }

  async dailyRecords(): Promise<DailyRecord[]> {
    return todo();
  }

  async history(): Promise<DailyRecord[]> {
    return todo();
  }

  async accessLog(): Promise<ScanEvent[]> {
    return todo();
  }
}
