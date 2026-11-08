import { randomUUID } from 'node:crypto';
import { LOCKOUT_MS, MAX_FAILED_LOGINS } from './iam.auth.js';
import type {
  NewUser,
  Notice,
  NoticeStore,
  SessionRecord,
  UserRecord,
  UserStore,
} from './iam.service.js';

/** In-memory UserStore and NoticeStore for tests, same semantics as IamRepo. */
export class InMemoryUsers implements UserStore, NoticeStore {
  notices: (Notice & { publishedBy: string })[] = [];
  acks = new Set<string>();
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

  async purgeSessions(before: Date) {
    for (const [id, s] of this.sessions) {
      if (s.expiresAt < before || (s.revokedAt && s.revokedAt < before)) this.sessions.delete(id);
    }
  }

  async currentNotice() {
    return this.notices.at(-1) ?? null;
  }

  // Synchronous between reading the max and pushing, so concurrent calls get distinct versions.
  async publishNotice(text: string, by: string) {
    const notice = {
      version: (this.notices.at(-1)?.version ?? 0) + 1,
      text,
      publishedAt: new Date(),
      publishedBy: by,
    };
    this.notices.push(notice);
    return notice;
  }

  async hasAcked(userId: string, version: number) {
    return this.acks.has(`${userId}:${version}`);
  }

  async ack(userId: string, version: number) {
    const key = `${userId}:${version}`;
    if (this.acks.has(key)) return false;
    this.acks.add(key);
    return true;
  }
}
