import { todo } from '../../shared/errors.js';
import type { Scope } from '../../shared/types.js';
import type { AuditLog } from '../iam/index.js';
import type { EmployeeQrRepo } from './employee-qr.repo.js';

export type DenyReason = 'INVALID_SIGNATURE' | 'EXPIRED' | 'REVOKED' | 'INACTIVE' | 'UNKNOWN';

export type ValidationResult =
  { ok: true; employeeId: string; firstName: string } | { ok: false; reason: DenyReason };

export interface EmployeeSummary {
  id: string;
  firstName: string;
  lastName: string;
  active: boolean;
}

export interface QrValidation {
  validate(token: string): Promise<ValidationResult>;
}

export interface EmployeeDirectory {
  find(id: string): Promise<EmployeeSummary | null>;
  list(scope: Scope): Promise<EmployeeSummary[]>;
}

/** Employees, QR issue/revoke/reissue, validation (FR-1.1 to FR-1.5). */
export class EmployeeQrService implements QrValidation, EmployeeDirectory {
  constructor(
    private repo: EmployeeQrRepo,
    private audit: AuditLog,
    private signingSecret: string,
  ) {}

  async validate(): Promise<ValidationResult> {
    return todo();
  }

  async find(): Promise<EmployeeSummary | null> {
    return todo();
  }

  async list(): Promise<EmployeeSummary[]> {
    return todo();
  }
}
