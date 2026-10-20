import type { PrismaClient } from '../../shared/prisma.js';

/** Owns: Gate, Heartbeat. */
export class GateRepo {
  constructor(private db: PrismaClient) {}
}
