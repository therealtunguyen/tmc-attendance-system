// Seeds a login account (FR-5.1): npm run user:create -- --username x --password y --role ADM
import { parseArgs } from 'node:util';
import {
  hashPassword,
  IamRepo,
  MFA_ROLES,
  newTotpSecret,
  otpauthUri,
  passwordProblem,
  type Role,
} from '../modules/iam/index.js';
import { config } from '../shared/config.js';
import { createPrisma } from '../shared/prisma.js';

const ROLES: Role[] = ['EMP', 'GRD', 'SUP', 'HR', 'ADM', 'EXE'];

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    password: { type: 'string' },
    role: { type: 'string' },
    'employee-id': { type: 'string' },
    scopes: { type: 'string' },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const { username, password, role } = values;
if (!username || !password || !role) fail('--username, --password and --role are required');
if (!ROLES.includes(role as Role)) fail(`--role must be one of ${ROLES.join(', ')}`);
const problem = passwordProblem(password!);
if (problem) fail(problem);

const userRole = role as Role;
const scopes = values.scopes?.split(',').filter(Boolean);
const mfaSecret = MFA_ROLES.includes(userRole) ? newTotpSecret() : undefined;

const db = createPrisma(config.databaseUrl);
const repo = new IamRepo(db);
const user = await repo.createUser({
  username: username!,
  passwordHash: await hashPassword(password!),
  role: userRole,
  // SUP is always scoped (FR-5.3), even when no scopes are given.
  scoped: scopes !== undefined || userRole === 'SUP',
  scopes: scopes ?? [],
  employeeId: values['employee-id'] ?? null,
  mfaSecret: mfaSecret ?? null,
});
await repo.append({
  actorId: 'system:cli',
  action: 'USER_CREATE',
  target: `user:${user.id}`,
  at: new Date(),
  after: { username: user.username, role: user.role, employeeId: user.employeeId },
});

console.log(`Created ${user.role} user ${user.username} (${user.id})`);
if (mfaSecret) {
  console.log(`MFA secret: ${mfaSecret}`);
  console.log(`otpauth URI: ${otpauthUri(user.username, mfaSecret)}`);
}
await db.$disconnect();
