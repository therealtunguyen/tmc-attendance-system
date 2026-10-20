import { todo } from '../../shared/errors.js';
import type { Scope } from '../../shared/types.js';
import type { IamRepo } from './iam.repo.js';

export type Role = 'EMP' | 'GRD' | 'SUP' | 'HR' | 'ADM' | 'EXE';

export interface UserRef {
  id: string;
  role: Role;
}

export interface AuditEntry {
  actorId: string;
  action: string;
  target: string;
  at: Date;
}

export interface AuditFilter {
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

export interface Authorizer {
  check(user: UserRef, permission: string, scope?: Scope): boolean;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  search(filter: AuditFilter): Promise<AuditEntry[]>;
}

/** Users, login, roles, audit log (FR-1.7, FR-4.7, FR-4.8, FR-5.1, FR-5.2). */
export class IamService implements Authorizer, AuditLog {
  constructor(private repo: IamRepo) {}

  check(): boolean {
    return todo();
  }

  async append(): Promise<void> {
    return todo();
  }

  async search(): Promise<AuditEntry[]> {
    return todo();
  }
}
