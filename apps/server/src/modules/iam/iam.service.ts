import type { Scope } from '../../shared/types.js';
import {
  hashPassword,
  hashToken,
  MFA_PENDING_TTL_MS,
  MFA_ROLES,
  newSessionToken,
  SESSION_TTL_MS,
  verifyPassword,
  verifyTotp,
} from './iam.auth.js';
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
  /** The linked employee record, if any (FR-5.1). */
  employeeId?: string;
}

/** A login account (FR-5.1). */
export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: Role;
  /** true = limited to scopes (possibly none); false = not limited. */
  scoped: boolean;
  scopes: Scope[];
  employeeId: string | null;
  mfaSecret: string | null;
  mfaLastStep: number | null;
  active: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
}

export type NewUser = Pick<UserRecord, 'username' | 'passwordHash' | 'role'> &
  Partial<Pick<UserRecord, 'scoped' | 'scopes' | 'employeeId' | 'mfaSecret'>>;

export interface SessionRecord {
  id: string;
  tokenHash: string;
  userId: string;
  mfaPassed: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Accounts and sessions. The raw session token never reaches the store, only its hash. */
export interface UserStore {
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUser(id: string): Promise<UserRecord | null>;
  /** Atomically adds a failed attempt; at MAX_FAILED_LOGINS locks the account and restarts the count. Returns whether it is now locked. */
  recordFailedLogin(id: string, now: Date): Promise<boolean>;
  /** Atomically records a TOTP step as used; false when that step or a later one was already used (replay). */
  useTotpStep(userId: string, step: number): Promise<boolean>;
  resetFailedLogins(id: string): Promise<void>;
  createUser(user: NewUser): Promise<UserRecord>;
  createSession(session: {
    tokenHash: string;
    userId: string;
    mfaPassed: boolean;
    expiresAt: Date;
  }): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  markSessionMfaPassed(id: string, expiresAt: Date): Promise<void>;
  revokeSession(id: string, at: Date): Promise<void>;
}

export type LoginResult =
  | { ok: true; token: string; mfaRequired: true }
  | { ok: true; token: string; mfaRequired: false; expiresAt: Date }
  | { ok: false; reason: 'INVALID_CREDENTIALS' | 'LOCKED' | 'MFA_NOT_ENROLLED' };

export type MfaResult = { ok: true; expiresAt: Date } | { ok: false };

/** Login, sessions and MFA (FR-5.2). */
export interface Authenticator {
  login(username: string, password: string): Promise<LoginResult>;
  verifyMfa(token: string, code: string): Promise<MfaResult>;
  /** The user behind a fully authenticated session, else null. */
  authenticate(token: string): Promise<UserRef | null>;
  logout(token: string): Promise<void>;
}

export interface AuditEntry {
  actorId: string;
  action: string;
  target: string;
  /** Ignored by stores: stores replace it with their own clock to prevent backdating. */
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

/** Checked against when the username is unknown, so response time does not reveal which usernames exist. */
const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');

/** Users, login, roles, audit log (FR-1.7, FR-4.7, FR-4.8, FR-5.1, FR-5.2). */
export class IamService implements Authorizer, AuditLog, AuditReader, Authenticator {
  constructor(
    private store: AuditStore & UserStore,
    private clock: () => number = Date.now,
  ) {}

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

  private audit(actorId: string, action: string, target: string) {
    return this.store.append({ actorId, action, target, at: new Date(this.clock()) });
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const now = this.clock();
    const user = await this.store.findUserByUsername(username);
    // Always hash, so unknown users cost the same as wrong passwords.
    const passwordOk = await verifyPassword(
      password,
      user?.passwordHash ?? (await DUMMY_HASH_PROMISE),
    );
    const actor = user?.id ?? `username:${username}`;
    const target = `user:${user?.id ?? '?'}`;

    if (user?.active && user.lockedUntil && user.lockedUntil.getTime() > now) {
      await this.audit(actor, 'LOGIN_LOCKED', target);
      return { ok: false, reason: 'LOCKED' };
    }
    if (!user || !user.active || !passwordOk) {
      if (user?.active) await this.store.recordFailedLogin(user.id, new Date(now));
      await this.audit(actor, 'LOGIN_FAIL', target);
      return { ok: false, reason: 'INVALID_CREDENTIALS' };
    }

    await this.store.resetFailedLogins(user.id);
    const token = newSessionToken();
    // TODO: self-service MFA enrollment; for now the seed script or an admin sets the secret.
    if (MFA_ROLES.includes(user.role)) {
      if (!user.mfaSecret) {
        await this.audit(actor, 'LOGIN_FAIL', target);
        return { ok: false, reason: 'MFA_NOT_ENROLLED' };
      }
      await this.store.createSession({
        tokenHash: hashToken(token),
        userId: user.id,
        mfaPassed: false,
        expiresAt: new Date(now + MFA_PENDING_TTL_MS),
      });
      await this.audit(actor, 'LOGIN_MFA_PENDING', target);
      return { ok: true, token, mfaRequired: true };
    }
    const expiresAt = new Date(now + SESSION_TTL_MS);
    await this.store.createSession({
      tokenHash: hashToken(token),
      userId: user.id,
      mfaPassed: true,
      expiresAt,
    });
    await this.audit(actor, 'LOGIN_OK', target);
    return { ok: true, token, mfaRequired: false, expiresAt };
  }

  /** A live session that has not been revoked or expired. */
  private async liveSession(token: string, now: number): Promise<SessionRecord | null> {
    const session = await this.store.findSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now) return null;
    return session;
  }

  async verifyMfa(token: string, code: string): Promise<MfaResult> {
    const now = this.clock();
    const session = await this.liveSession(token, now);
    if (!session || session.mfaPassed) return { ok: false };
    const user = await this.store.findUser(session.userId);
    const target = `user:${session.userId}`;
    if (!user?.active || !user.mfaSecret) return { ok: false };
    if (user.lockedUntil && user.lockedUntil.getTime() > now) return { ok: false };
    const step = verifyTotp(user.mfaSecret, code, now);
    // A replayed code counts as a failure.
    if (step === null || !(await this.store.useTotpStep(user.id, step))) {
      await this.store.recordFailedLogin(user.id, new Date(now));
      await this.audit(user.id, 'MFA_FAIL', target);
      return { ok: false };
    }
    const expiresAt = new Date(now + SESSION_TTL_MS);
    await this.store.markSessionMfaPassed(session.id, expiresAt);
    await this.audit(user.id, 'MFA_OK', target);
    return { ok: true, expiresAt };
  }

  async authenticate(token: string): Promise<UserRef | null> {
    const now = this.clock();
    const session = await this.liveSession(token, now);
    if (!session?.mfaPassed) return null;
    const user = await this.store.findUser(session.userId);
    if (!user?.active || (user.lockedUntil && user.lockedUntil.getTime() > now)) return null;
    return {
      id: user.id,
      role: user.role,
      scopes: user.scoped ? user.scopes : undefined,
      employeeId: user.employeeId ?? undefined,
    };
  }

  async logout(token: string): Promise<void> {
    const now = this.clock();
    const session = await this.liveSession(token, now);
    if (!session) return;
    await this.store.revokeSession(session.id, new Date(now));
    await this.audit(session.userId, 'LOGOUT', `user:${session.userId}`);
  }
}
