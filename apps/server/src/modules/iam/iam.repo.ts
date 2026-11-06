import type { PrismaClient } from '../../shared/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { LOCKOUT_MS, MAX_FAILED_LOGINS } from './iam.auth.js';
import { chainHash, GENESIS_HASH } from './iam.audit-chain.js';
import type {
  AuditEntry,
  AuditFilter,
  AuditStore,
  ChainedEntry,
  NewUser,
  Role,
  SessionRecord,
  UserRecord,
  UserStore,
} from './iam.service.js';

/** Arbitrary constant key; serialises appends so the chain has no forks. */
const AUDIT_LOCK_KEY = 4510001n;

const json = (value: unknown) =>
  value === undefined || value === null ? undefined : (value as Prisma.InputJsonValue);

const toEntry = (row: {
  seq: number;
  actorId: string;
  action: string;
  target: string;
  at: Date;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  prevHash: string;
  hash: string;
}): ChainedEntry => ({
  seq: row.seq,
  actorId: row.actorId,
  action: row.action,
  target: row.target,
  at: row.at,
  before: row.before ?? undefined,
  after: row.after ?? undefined,
  prevHash: row.prevHash,
  hash: row.hash,
});

const toUser = (row: {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  scoped: boolean;
  scopes: string[];
  employeeId: string | null;
  mfaSecret: string | null;
  mfaLastStep: number | null;
  active: boolean;
  failedLogins: number;
  lockedUntil: Date | null;
}): UserRecord => ({ ...row, role: row.role as Role });

/** Owns: User, Session, Role, AuditEntry, NoticeAck. */
export class IamRepo implements AuditStore, UserStore {
  constructor(private db: PrismaClient) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;
      const last = await tx.auditEntry.findFirst({
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });
      const prevHash = last?.hash ?? GENESIS_HASH;
      // The time comes from the store, so callers cannot backdate.
      const at = new Date();
      await tx.auditEntry.create({
        data: {
          actorId: entry.actorId,
          action: entry.action,
          target: entry.target,
          at,
          before: json(entry.before),
          after: json(entry.after),
          prevHash,
          hash: chainHash(prevHash, { ...entry, at }),
        },
      });
    });
  }

  async search(filter: AuditFilter): Promise<ChainedEntry[]> {
    const rows = await this.db.auditEntry.findMany({
      where: {
        actorId: filter.actorId,
        action: filter.action,
        target: filter.target,
        at: { gte: filter.from, lte: filter.to },
      },
      orderBy: { seq: 'desc' },
      take: filter.limit,
    });
    return rows.map(toEntry);
  }

  async chain(): Promise<ChainedEntry[]> {
    const rows = await this.db.auditEntry.findMany({ orderBy: { seq: 'asc' } });
    return rows.map(toEntry);
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.db.user.findUnique({ where: { username } });
    return row && toUser(row);
  }

  async findUser(id: string): Promise<UserRecord | null> {
    const row = await this.db.user.findUnique({ where: { id } });
    return row && toUser(row);
  }

  async recordFailedLogin(id: string, now: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      // The increment takes the row lock, so parallel failures are counted one by one.
      const { failedLogins } = await tx.user.update({
        where: { id },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      });
      if (failedLogins < MAX_FAILED_LOGINS) return false;
      await tx.user.update({
        where: { id },
        data: { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) },
      });
      return true;
    });
  }

  async useTotpStep(userId: string, step: number): Promise<boolean> {
    const { count } = await this.db.user.updateMany({
      where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    return count === 1;
  }

  async resetFailedLogins(id: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { failedLogins: 0, lockedUntil: null } });
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    return toUser(await this.db.user.create({ data: user }));
  }

  async createSession(session: {
    tokenHash: string;
    userId: string;
    mfaPassed: boolean;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.session.create({ data: session });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.db.session.findUnique({ where: { tokenHash } });
  }

  async markSessionMfaPassed(id: string, expiresAt: Date): Promise<void> {
    await this.db.session.update({ where: { id }, data: { mfaPassed: true, expiresAt } });
  }

  async revokeSession(id: string, at: Date): Promise<void> {
    await this.db.session.update({ where: { id }, data: { revokedAt: at } });
  }
}
