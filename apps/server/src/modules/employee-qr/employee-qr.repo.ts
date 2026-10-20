import type { PrismaClient } from '../../shared/prisma.js';

/** Owns: Employee, QrCredential. */
export class EmployeeQrRepo {
  constructor(private db: PrismaClient) {}
}
