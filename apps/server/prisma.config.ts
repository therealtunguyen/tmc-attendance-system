import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// The .env file lives at the repo root; Prisma 7 does not load it on its own.
if (existsSync('../../.env')) process.loadEnvFile('../../.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` runs in CI without a database, so the URL may be empty there.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
