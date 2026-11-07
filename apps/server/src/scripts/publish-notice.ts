// Publishes the next privacy notice version (NFR-20): npm run notice:publish -- notice.txt
import { readFile } from 'node:fs/promises';
import { IamRepo, IamService } from '../modules/iam/index.js';
import { config } from '../shared/config.js';
import { createPrisma } from '../shared/prisma.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run notice:publish -- <text file>');
  process.exit(1);
}

const db = createPrisma(config.databaseUrl);
const notice = await new IamService(new IamRepo(db)).publishNotice(
  'system:cli',
  await readFile(file, 'utf8'),
);
console.log(`Published privacy notice v${notice.version}`);
await db.$disconnect();
