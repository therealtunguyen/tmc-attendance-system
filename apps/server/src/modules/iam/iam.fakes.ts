import { randomUUID } from 'node:crypto';
import { LOCKOUT_MS, MAX_FAILED_LOGINS } from './iam.auth.js';
import type { NewUser, SessionRecord, UserRecord, UserStore } from './iam.service.js';

/** In-memory UserStore for tests, same semantics as IamRepo. */
export class InMemoryUsers implements UserStore {
  users = new Map<string, UserRecord>();
  sessions = new Map<string, SessionRecord>();

  async findUserByUsername(username: string) {
    return [...this.users.values()].find((u) => u.username === username) ?? null;
  }

  async findUser(id: string) {
    return this.users.get(id) ?? null;
  }

  async recordFailedLogin(id: string, now: Date) {
    const user = this.users.get(id)!;
    user.failedLogins += 1;
    if (user.failedLogins < MAX_FAILED_LOGINS) return false;
    Object.assign(user, { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) });
    return true;
  }

  async useTotpStep(userId: string, step: number) {
    const user = this.users.get(userId)!;
    if (user.mfaLastStep !== null && user.mfaLastStep >= step) return false;
    user.mfaLastStep = step;
    return true;
  }

  async resetFailedLogins(id: string) {
    Object.assign(this.users.get(id)!, { failedLogins: 0, lockedUntil: null });
  }

  async createUser(data: NewUser) {
    const user: UserRecord = {
      id: randomUUID(),
      scoped: false,
      scopes: [],
      employeeId: null,
      mfaSecret: null,
      mfaLastStep: null,
      active: true,
      failedLogins: 0,
      lockedUntil: null,
      ...data,
    };
    this.users.set(user.id, user);
    return user;
  }

  async createSession(s: {
    tokenHash: string;
    userId: string;
    mfaPassed: boolean;
    expiresAt: Date;
  }) {
    const id = randomUUID();
    this.sessions.set(id, { id, revokedAt: null, ...s });
  }

  async findSessionByTokenHash(tokenHash: string) {
    return [...this.sessions.values()].find((s) => s.tokenHash === tokenHash) ?? null;
  }

  async markSessionMfaPassed(id: string, expiresAt: Date) {
    Object.assign(this.sessions.get(id)!, { mfaPassed: true, expiresAt });
  }

  async revokeSession(id: string, at: Date) {
    this.sessions.get(id)!.revokedAt = at;
  }
}
