import type { PrismaClient } from '../../shared/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { chainHash, GENESIS_HASH } from './iam.audit-chain.js';
import type { AuditEntry, AuditFilter, AuditStore, ChainedEntry } from './iam.service.js';

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

/** Owns: User, Role, AuditEntry, NoticeAck. */
export class IamRepo implements AuditStore {
  constructor(private db: PrismaClient) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;
      const last = await tx.auditEntry.findFirst({
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });
      const prevHash = last?.hash ?? GENESIS_HASH;
      await tx.auditEntry.create({
        data: {
          actorId: entry.actorId,
          action: entry.action,
          target: entry.target,
          at: entry.at,
          before: json(entry.before),
          after: json(entry.after),
          prevHash,
          hash: chainHash(prevHash, entry),
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
}
