import type { EdgeSnapshot } from '../../shared/contracts/edge.js';
import { todo } from '../../shared/errors.js';
import type { Scope } from '../../shared/types.js';
import type { AuditLog } from '../iam/index.js';

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
  /** Sets active = false and qrRevoked = true in one write (FR-1.5). */
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
  constructor(
    private repo: EmployeeStore,
    private audit: AuditLog,
    private keys: QrKeyConfig,
  ) {}

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
    if (!before.active) return before;
    const employee = await this.repo.deactivate(id);
    if (employee) await this.record(actorId, 'EMPLOYEE_DEACTIVATE', id);
    return employee;
  }

  async validate(): Promise<ValidationResult> {
    return todo();
  }

  async issueToken(): Promise<string> {
    return todo();
  }

  async snapshot(): Promise<EdgeSnapshot> {
    return todo();
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

/** Drops contact and org fields before another module sees the employee. */
const summary = ({ id, firstName, lastName, active }: Employee): EmployeeSummary => ({
  id,
  firstName,
  lastName,
  active,
});
