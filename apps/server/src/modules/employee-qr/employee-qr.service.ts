import { randomUUID } from 'node:crypto';
import type { EdgeSnapshot, SnapshotEmployee } from '../../shared/contracts/edge.js';
import { QR_TOKEN_TTL_S, signQrToken } from '../../shared/contracts/qr-token.js';
import {
  checkQrToken,
  type QrCheckResult,
  type QrDenyReason,
} from '../../shared/contracts/qr-validation.js';
import type { Scope } from '../../shared/types.js';
import type { AuditLog } from '../iam/index.js';
import { QrKeyring } from './employee-qr.keys.js';

/** REPLAYED: a jti already seen (ADR-10); only the edge checks it. */
export type DenyReason = QrDenyReason | 'REPLAYED';

/** Rules in shared/contracts/qr-validation.ts, so the edge decides exactly like the server. */
export type ValidationResult = QrCheckResult | { ok: false; reason: 'REPLAYED'; jti: string };

export interface EmployeeSummary {
  id: string;
  firstName: string;
  lastName: string;
  active: boolean;
}

/** Full profile for HR screens (FR-1.1). Other modules only get EmployeeSummary (NFR-4). */
export interface Employee extends EmployeeSummary {
  code: string;
  email: string;
  factoryId: string;
  teamId: string | null;
  qrRevoked: boolean;
}

export type NewEmployee = Pick<
  Employee,
  'code' | 'firstName' | 'lastName' | 'email' | 'factoryId' | 'teamId'
>;

/** The employee code is HR's key for the person, so it never changes. */
export type EmployeeChanges = Partial<Omit<NewEmployee, 'code'>>;

export class DuplicateEmployeeCodeError extends Error {
  constructor(code: string) {
    super(`Employee code ${code} already exists`);
  }
}

/** Storage the service needs. The Prisma repo implements it; tests use an in-memory one. */
export interface EmployeeStore {
  /** Throws DuplicateEmployeeCodeError. */
  create(data: NewEmployee): Promise<Employee>;
  /** Null when there is no such employee. */
  update(id: string, changes: EmployeeChanges): Promise<Employee | null>;
  find(id: string): Promise<Employee | null>;
  /** All employees, or those in one factory or team. */
  list(scope?: Scope): Promise<Employee[]>;
  /** Sets active = false and qrRevoked = true in one conditional write (FR-1.5). Null when there is nothing to change (unknown, or already deactivated and revoked). */
  deactivate(id: string): Promise<Employee | null>;
}

/** HR maintains employees (FR-1.1, FR-1.5). Every change is audited (FR-4.7). */
export interface EmployeeAdmin {
  createEmployee(actorId: string, data: NewEmployee): Promise<Employee>;
  updateEmployee(actorId: string, id: string, changes: EmployeeChanges): Promise<Employee | null>;
  getProfile(id: string): Promise<Employee | null>;
  listProfiles(scope?: Scope): Promise<Employee[]>;
  deactivateEmployee(actorId: string, id: string): Promise<Employee | null>;
}

/** Ed25519 keys as base64 DER (see .env.example). previous* empty when there was no rotation. */
export interface QrKeyConfig {
  kid: string;
  privateKey: string;
  previousKid: string;
  previousPublicKey: string;
}

/** issueToken refuses an employee who would be denied at the gate anyway. */
/** The QR keys are missing or malformed (a deployment problem, not a caller one). */
export class QrNotConfiguredError extends Error {}

export class QrNotIssuableError extends Error {
  constructor(readonly reason: 'UNKNOWN' | 'INACTIVE' | 'REVOKED') {
    super(`No QR token: employee is ${reason.toLowerCase()}`);
  }
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
  implements QrValidation, QrIssuer, EdgeSnapshotSource, EmployeeDirectory, EmployeeAdmin
{
  private keyring?: QrKeyring;

  constructor(
    private repo: EmployeeStore,
    private audit: AuditLog,
    private keys: QrKeyConfig,
    private now: () => Date = () => new Date(),
  ) {}

  /** Built on first use, so the server still starts (and serves everything else) without QR keys. */
  private get ring(): QrKeyring {
    try {
      return (this.keyring ??= new QrKeyring(this.keys));
    } catch (e) {
      throw new QrNotConfiguredError((e as Error).message);
    }
  }

  async createEmployee(actorId: string, data: NewEmployee): Promise<Employee> {
    const employee = await this.repo.create(data);
    await this.record(actorId, 'EMPLOYEE_CREATE', employee.id);
    return employee;
  }

  async updateEmployee(
    actorId: string,
    id: string,
    changes: EmployeeChanges,
  ): Promise<Employee | null> {
    const employee = await this.repo.update(id, changes);
    // TODO(#45): write the change and its audit entry in one transaction
    if (employee) await this.record(actorId, 'EMPLOYEE_UPDATE', id);
    return employee;
  }

  async getProfile(id: string): Promise<Employee | null> {
    return this.repo.find(id);
  }

  async listProfiles(scope?: Scope): Promise<Employee[]> {
    return this.repo.list(scope);
  }

  /** Deactivating also revokes the QR, so the next snapshot denies the employee at every edge (FR-1.5). */
  async deactivateEmployee(actorId: string, id: string): Promise<Employee | null> {
    const before = await this.repo.find(id);
    if (!before) return null;
    if (!before.active && before.qrRevoked) return before;
    const employee = await this.repo.deactivate(id);
    // Null: a concurrent request got there first, and it audits.
    if (!employee) return this.repo.find(id);
    // TODO(#45): write the change and its audit entry in one transaction
    await this.record(actorId, 'EMPLOYEE_DEACTIVATE', id);
    return employee;
  }

  /**
   * Server-side check (FR-2.2), e.g. for the kiosk route until it moves to the edge (#29).
   * A repository error rejects (fail closed): the caller maps it to 5xx and the gate never opens.
   * Does not check jti reuse: the edge does (#25), so no kiosk route may call this directly before #29.
   */
  async validate(token: string): Promise<ValidationResult> {
    return checkQrToken(token, {
      publicKeys: this.ring.publicKeys(),
      findEmployee: async (id) => {
        const employee = await this.repo.find(id);
        return employee && admission(employee);
      },
      nowS: Math.floor(this.now().getTime() / 1000),
    });
  }

  /** Signed with the current key; a fresh jti every call, so a screenshot is useless after TTL (ADR-10). */
  async issueToken(employeeId: string): Promise<string> {
    const employee = await this.repo.find(employeeId);
    if (!employee) throw new QrNotIssuableError('UNKNOWN');
    const { deny } = admission(employee);
    if (deny) throw new QrNotIssuableError(deny);
    const exp = Math.floor(this.now().getTime() / 1000) + QR_TOKEN_TTL_S;
    const { kid, signingKey } = this.ring;
    return signQrToken({ sub: employee.id, exp, jti: randomUUID() }, kid, signingKey);
  }

  /**
   * The whole company, not one factory, and denied employees too: missing means UNKNOWN to the edge.
   * generatedAt is taken before the read, so the edge can only think its deny states are older than they are.
   */
  async snapshot(): Promise<EdgeSnapshot> {
    const generatedAt = this.now().toISOString();
    const publicKeys = this.ring.edgePublicKeys();
    return { generatedAt, publicKeys, employees: (await this.repo.list()).map(admission) };
  }

  async find(id: string): Promise<EmployeeSummary | null> {
    const employee = await this.repo.find(id);
    return employee && summary(employee);
  }

  async list(scope: Scope): Promise<EmployeeSummary[]> {
    return (await this.repo.list(scope)).map(summary);
  }

  private record(actorId: string, action: string, employeeId: string) {
    return this.audit.append({ actorId, action, target: `employee:${employeeId}`, at: new Date() });
  }
}

/** What a gate needs to know about an employee; also one entry of the edge snapshot (ADR-9). */
const admission = ({ id, firstName, active, qrRevoked }: Employee): SnapshotEmployee => ({
  id,
  firstName,
  deny: !active ? 'INACTIVE' : qrRevoked ? 'REVOKED' : null,
});

/** Drops contact and org fields before another module sees the employee. */
const summary = ({ id, firstName, lastName, active }: Employee): EmployeeSummary => ({
  id,
  firstName,
  lastName,
  active,
});
