import type { PrismaClient } from '../../shared/prisma.js';

/** Owns: OrgUnit, ConfigValue. */
export class AdminRepo {
  constructor(private db: PrismaClient) {}
}
