import type { EdgeSnapshot } from '../../shared/contracts/edge.js';
import { todo } from '../../shared/errors.js';
import type { Scope } from '../../shared/types.js';
import type { AuditLog } from '../iam/index.js';
import type { EmployeeQrRepo } from './employee-qr.repo.js';

/** REPLAYED: a jti already seen (ADR-10). */
export type DenyReason =
  'INVALID_SIGNATURE' | 'EXPIRED' | 'REVOKED' | 'INACTIVE' | 'UNKNOWN' | 'REPLAYED';

export type ValidationResult =
  { ok: true; employeeId: string; firstName: string } | { ok: false; reason: DenyReason };

export interface EmployeeSummary {
  id: string;
  firstName: string;
  lastName: string;
  active: boolean;
}

/** Ed25519 keys as base64 DER (see .env.example). previous* empty when there was no rotation. */
export interface QrKeyConfig {
  kid: string;
  privateKey: string;
  previousKid: string;
  previousPublicKey: string;
}

export interface QrIssuer {
  /** Short-lived token for the employee's live QR (ADR-10, FR-1.2). Token format: shared/contracts/qr-token.ts. */
  issueToken(employeeId: string): Promise<string>;
}

export interface EdgeSnapshotSource {
  /** Public keys and employee deny states for GET /api/edge/snapshot (ADR-9). */
  snapshot(): Promise<EdgeSnapshot>;
}

export interface QrValidation {
  validate(token: string): Promise<ValidationResult>;
}

export interface EmployeeDirectory {
  find(id: string): Promise<EmployeeSummary | null>;
  list(scope: Scope): Promise<EmployeeSummary[]>;
}

/** Employees, QR issue/revoke/reissue, validation (FR-1.1 to FR-1.5). */
export class EmployeeQrService
  implements QrValidation, QrIssuer, EdgeSnapshotSource, EmployeeDirectory
{
  constructor(
    private repo: EmployeeQrRepo,
    private audit: AuditLog,
    private keys: QrKeyConfig,
  ) {}

  async validate(): Promise<ValidationResult> {
    return todo();
  }

  async issueToken(): Promise<string> {
    return todo();
  }

  async snapshot(): Promise<EdgeSnapshot> {
    return todo();
  }

  async find(): Promise<EmployeeSummary | null> {
    return todo();
  }

  async list(): Promise<EmployeeSummary[]> {
    return todo();
  }
}
