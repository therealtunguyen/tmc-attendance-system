import type { PrismaClient } from '../../shared/prisma.js';

/** Owns: User, Role, AuditEntry, NoticeAck. */
export class IamRepo {
  constructor(private db: PrismaClient) {}
}
