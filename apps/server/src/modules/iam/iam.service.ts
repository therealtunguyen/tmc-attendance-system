import type { Scope } from '../../shared/types.js';
import { check, type Permission } from './iam.rbac.js';
import { verifyChain, type ChainedEntry, type ChainVerdict } from './iam.audit-chain.js';

export type { ChainedEntry, ChainVerdict } from './iam.audit-chain.js';

export type Role = 'EMP' | 'GRD' | 'SUP' | 'HR' | 'ADM' | 'EXE';

export interface UserRef {
  id: string;
  role: Role;
  /**
   * Org unit IDs (factory or team) the user is limited to (FR-5.3, BR-15).
   * undefined = not limited, except for SUP, which is always team-scoped:
   * undefined or empty then means no team at all.
   */
  scopes?: Scope[];
}

export interface AuditEntry {
  actorId: string;
  action: string;
  target: string;
  at: Date;
  /** Values before and after a data change (FR-4.9). Omit for actions that change nothing. */
  before?: unknown;
  after?: unknown;
}

export interface AuditFilter {
  actorId?: string;
  action?: string;
  target?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface Authorizer {
  check(user: UserRef, permission: Permission, scope?: Scope): boolean;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  search(filter: AuditFilter): Promise<AuditEntry[]>;
}

/** Read side of the log, for the review routes (FR-4.10). */
export interface AuditReader {
  search(filter: AuditFilter): Promise<ChainedEntry[]>;
  verify(): Promise<ChainVerdict>;
}

/** Append-only, hash-chained storage (FR-4.9). There is no update or delete. */
export interface AuditStore {
  /** Links the entry to the end of the chain atomically. */
  append(entry: AuditEntry): Promise<void>;
  /** Newest first. */
  search(filter: AuditFilter): Promise<ChainedEntry[]>;
  /** Every entry, ordered by seq ascending. */
  chain(): Promise<ChainedEntry[]>;
}

export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;

/** Users, login, roles, audit log (FR-1.7, FR-4.7, FR-4.8, FR-5.1, FR-5.2). */
export class IamService implements Authorizer, AuditLog, AuditReader {
  constructor(private store: AuditStore) {}

  check(user: UserRef, permission: Permission, scope?: Scope): boolean {
    return check(user, permission, scope);
  }

  append(entry: AuditEntry): Promise<void> {
    return this.store.append(entry);
  }

  search(filter: AuditFilter = {}): Promise<ChainedEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT);
    return this.store.search({ ...filter, limit });
  }

  /** Tamper check (FR-4.9): walks the whole chain. */
  async verify(): Promise<ChainVerdict> {
    return verifyChain(await this.store.chain());
  }
}
