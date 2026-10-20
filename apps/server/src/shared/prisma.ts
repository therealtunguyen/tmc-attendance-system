import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type { PrismaClient };

export const createPrisma = (connectionString: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
