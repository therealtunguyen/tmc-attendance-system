// Cross-module flow (#13): portal token -> snapshot check -> sync -> daily record, as far as main has it.
// Real services, routes, session check and Ed25519 keys, mounted the way main.ts mounts them (this does
// not import main.ts). Only the Prisma repos are faked, so eventId dedupe here is the fake's, not Postgres.
// The edge is simulated (edgeScan): which events an edge stores and pushes is not tested here.
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import {
  AttendanceService,
  attendanceRoutes,
  type AttendanceStore,
  type StoredEvent,
} from './modules/attendance/index.js';
import {
  DuplicateEmployeeCodeError,
  EmployeeQrService,
  employeeQrRoutes,
  type Employee,
  type EmployeeStore,
  type NewEmployee,
} from './modules/employee-qr/index.js';
import {
  authenticate,
  hashPassword,
  IamService,
  iamRoutes,
  type AuditEntry,
  type AuditStore,
  type UserRecord,
  type UserStore,
} from './modules/iam/index.js';
import type { EdgeEvent, EdgeSnapshot } from './shared/contracts/edge.js';
import { checkQrToken } from './shared/contracts/qr-validation.js';
import type { Scope } from './shared/types.js';

/** Only the methods this flow calls; the service gets it through one cast below. */
class InMemoryEmployees implements Pick<
  EmployeeStore,
  'create' | 'find' | 'list' | 'setQrRevoked'
> {
  rows = new Map<string, Employee>();

  async create(data: NewEmployee) {
    if ([...this.rows.values()].some((e) => e.code === data.code)) {
      throw new DuplicateEmployeeCodeError(data.code);
    }
    const employee = { ...data, id: randomUUID(), active: true, qrRevoked: false };
    this.rows.set(employee.id, employee);
    return { ...employee };
  }

  async find(id: string) {
    const employee = this.rows.get(id);
    return employee ? { ...employee } : null;
  }

  async list(scope?: Scope) {
    return [...this.rows.values()].filter(
      (e) => scope === undefined || e.factoryId === scope || e.teamId === scope,
    );
  }

  async setQrRevoked(id: string, revoked: boolean) {
    const employee = this.rows.get(id);
    if (!employee || employee.qrRevoked === revoked || (!revoked && !employee.active)) return null;
    return this.write(id, { qrRevoked: revoked });
  }

  private write(id: string, changes: Partial<Employee>) {
    const employee = this.rows.get(id);
    return employee ? { ...Object.assign(employee, changes) } : null;
  }
}

/** Same contract as AttendanceRepo for what ingest and dailyRecords call: a known eventId is skipped. */
class InMemoryEvents implements Pick<AttendanceStore, 'insert' | 'insertMany' | 'grantedEvents'> {
  rows = new Map<string, StoredEvent>();

  async insert(event: StoredEvent) {
    if (this.rows.has(event.eventId)) return false;
    this.rows.set(event.eventId, { ...event });
    return true;
  }

  async insertMany(events: StoredEvent[]) {
    for (const event of events) await this.insert(event);
  }

  async grantedEvents(from: Date, to: Date, employeeIds?: string[]) {
    return [...this.rows.values()].filter(
      (e) =>
        e.outcome === 'GRANTED' &&
        e.employeeId !== null &&
        (!employeeIds || employeeIds.includes(e.employeeId)) &&
        e.occurredAt >= from &&
        e.occurredAt < to,
    );
  }
}

/** Only what login and authenticate call; iam.fakes.ts is internal to the IAM module. */
const inMemoryIam = () => {
  const users: UserRecord[] = [];
  const sessions: NonNullable<Awaited<ReturnType<UserStore['findSessionByTokenHash']>>>[] = [];
  const audit: AuditEntry[] = [];
  const store = {
    findUserByUsername: async (username: string) =>
      users.find((u) => u.username === username) ?? null,
    findUser: async (id: string) => users.find((u) => u.id === id) ?? null,
    resetFailedLogins: async () => {},
    createSession: async (s: Parameters<UserStore['createSession']>[0]) => {
      sessions.push({ id: randomUUID(), revokedAt: null, ...s });
    },
    findSessionByTokenHash: async (tokenHash: string) =>
      sessions.find((s) => s.tokenHash === tokenHash) ?? null,
    append: async (entry: AuditEntry) => {
      audit.push(entry);
    },
  } as unknown as AuditStore & UserStore;
  return { store, users, audit };
};

const user = (fields: Pick<UserRecord, 'username' | 'passwordHash' | 'role'>): UserRecord => ({
  id: randomUUID(),
  scoped: false,
  scopes: [],
  employeeId: null,
  mfaSecret: null,
  mfaLastStep: null,
  active: true,
  failedLogins: 0,
  lockedUntil: null,
  ...fields,
});

const { privateKey } = generateKeyPairSync('ed25519');
const qrKeys = {
  kid: 'k1',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  previousKid: '',
  previousPublicKey: '',
};

const FACTORY = 'binh-duong';
const GATE = 'bd-gate-1';
const EDGE = 'edge-bd';
const PASSWORD = 'correct-horse-42';
const FAST_SCRYPT = { N: 2, r: 1, p: 1 };
const IN_AT = '2026-11-07T00:58:00.000Z'; // 07:58 in Vietnam
const OUT_AT = '2026-11-07T10:03:00.000Z'; // 17:03 in Vietnam
const TODAY = { from: new Date('2026-11-07T05:00:00Z'), to: new Date('2026-11-07T05:00:00Z') };

let nowMs: number;
let employees: InMemoryEmployees;
let events: InMemoryEvents;
let iamStore: ReturnType<typeof inMemoryIam>;
let eqr: EmployeeQrService;
let attendance: AttendanceService;
let app: ReturnType<typeof createApp>;
const HR_SESSION = 'hr-session-token';

beforeEach(() => {
  nowMs = Date.parse(IN_AT);
  employees = new InMemoryEmployees();
  events = new InMemoryEvents();
  iamStore = inMemoryIam();
  // Same order and same before-handler as main.ts. Random 1 skips the login's session purge.
  const iam = new IamService(iamStore.store, Date.now, () => 1);
  eqr = new EmployeeQrService(
    employees as unknown as EmployeeStore,
    iam,
    qrKeys,
    () => new Date(nowMs),
  );
  attendance = new AttendanceService(events as unknown as AttendanceStore, eqr);
  app = createApp(
    [
      iamRoutes(iam, { login: false, mfa: false }),
      employeeQrRoutes(eqr),
      attendanceRoutes(attendance),
    ],
    { before: [authenticate(iam)] },
  );
});

/** HR needs MFA to log in (covered in iam.login.test.ts), so its finished session is seeded. */
const seedHrSession = async () => {
  const hr = user({ username: 'hr', passwordHash: 'unused', role: 'HR' });
  iamStore.users.push(hr);
  await iamStore.store.createSession({
    tokenHash: createHash('sha256').update(HR_SESSION).digest('hex'),
    userId: hr.id,
    mfaPassed: true,
    expiresAt: new Date(Date.now() + 60_000),
  });
};

/** HR creates the employee over HTTP, then the employee logs in. Returns their id and session. */
const onboard = async (code: string) => {
  await seedHrSession();
  const created = await request(app)
    .post('/api/employees')
    .set('Authorization', `Bearer ${HR_SESSION}`)
    .send({
      code,
      firstName: 'Lan',
      lastName: 'Nguyen',
      email: `${code}@tmc.vn`,
      factoryId: FACTORY,
    });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const passwordHash = await hashPassword(PASSWORD, FAST_SCRYPT);
  iamStore.users.push({
    ...user({ username: code, passwordHash, role: 'EMP' }),
    employeeId: id,
  });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: code, password: PASSWORD });
  expect(login.status).toBe(200);
  return { id, session: login.body.token as string };
};

const issueQr = (session: string) =>
  request(app).post('/api/qr/token').set('Authorization', `Bearer ${session}`).send();

/**
 * shortcut: stands in for apps/edge's scan (#24, unmerged), replace with scan() + flushOutbox once merged.
 * Checks the token against the snapshot route with the shared check. The returned event is the test's
 * own input for the push; nothing here asserts what a real edge would store, or whether it opens TCS.
 */
const edgeScan = async (token: string): Promise<{ event: EdgeEvent; reason?: string }> => {
  const snapshot = (await request(app).get('/api/edge/snapshot')).body as EdgeSnapshot;
  const result = await checkQrToken(token, {
    publicKeys: Object.fromEntries(
      snapshot.publicKeys.map(({ kid, spki }) => [
        kid,
        createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' }),
      ]),
    ),
    findEmployee: (id) => snapshot.employees.find((e) => e.id === id) ?? null,
    nowS: Math.floor(nowMs / 1000),
  });
  return {
    reason: result.ok ? undefined : result.reason,
    event: {
      eventId: randomUUID(),
      gateId: GATE,
      employeeId: result.ok ? result.employeeId : null,
      method: 'QR',
      outcome: result.ok ? 'GRANTED' : 'DENIED',
      occurredAt: new Date(nowMs).toISOString(),
      jti: result.jti ?? null,
      stale: false,
    },
  };
};

const push = (...batch: EdgeEvent[]) =>
  request(app).post('/api/edge/events').send({ edgeId: EDGE, events: batch });

describe('cross-module flow: real routes, in-memory stores, simulated edge', () => {
  it('a portal token passes the snapshot check, and its pushed event shows up in the daily record', async () => {
    const lan = await onboard('BD-0001');

    const inQr = await issueQr(lan.session);
    expect(inQr.status).toBe(200);
    expect(await eqr.validate(inQr.body.token)).toMatchObject({
      ok: true,
      employeeId: lan.id,
      firstName: 'Lan',
    });
    const scanIn = await edgeScan(inQr.body.token);
    expect(scanIn.reason).toBeUndefined();

    const pushed = await push(scanIn.event);
    expect(pushed.status).toBe(200);
    expect(pushed.body).toEqual({ accepted: [scanIn.event.eventId] });

    // The outbox retries until confirmed, so the same event arrives again. First write wins (in the fake).
    const again = await push({ ...scanIn.event, outcome: 'DENIED' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ accepted: [scanIn.event.eventId] });
    expect(events.rows.size).toBe(1);
    expect(events.rows.get(scanIn.event.eventId)).toMatchObject({
      edgeId: EDGE,
      jti: scanIn.event.jti,
      outcome: 'GRANTED',
    });

    expect(await attendance.dailyRecords(TODAY, FACTORY)).toEqual([
      {
        employeeId: lan.id,
        day: new Date('2026-11-06T17:00:00Z'),
        firstIn: new Date(IN_AT),
        lastOut: null,
        hours: 0,
        missingPunch: true,
      },
    ]);

    nowMs = Date.parse(OUT_AT);
    const scanOut = await edgeScan((await issueQr(lan.session)).body.token);
    expect((await push(scanOut.event, scanIn.event)).status).toBe(200);
    expect(events.rows.size).toBe(2);

    expect(await attendance.dailyRecords(TODAY, FACTORY)).toEqual([
      {
        employeeId: lan.id,
        day: new Date('2026-11-06T17:00:00Z'),
        firstIn: new Date(IN_AT),
        lastOut: new Date(OUT_AT),
        hours: 9.08,
        missingPunch: false,
      },
    ]);
  });

  it('a revoked employee is denied by the server check and the snapshot, and a DENIED event gives no attendance', async () => {
    const lan = await onboard('BD-0002');
    const qr = await issueQr(lan.session);
    expect((await eqr.validate(qr.body.token)).ok).toBe(true);

    const revoked = await request(app)
      .post(`/api/employees/${lan.id}/qr/revoke`)
      .set('Authorization', `Bearer ${HR_SESSION}`)
      .send();
    expect(revoked.status).toBe(200);
    expect(iamStore.audit.map((e) => e.action)).toContain('QR_REVOKE');

    // The token was issued before the revocation and has not expired: only the deny state stops it.
    expect(await eqr.validate(qr.body.token)).toMatchObject({ ok: false, reason: 'REVOKED' });
    const scan = await edgeScan(qr.body.token);
    expect(scan.reason).toBe('REVOKED');

    // Today's edge does not store this denial; it will once #24 lands. The server keeps it as sent.
    expect((await push(scan.event)).status).toBe(200);
    expect(events.rows.get(scan.event.eventId)?.outcome).toBe('DENIED');
    expect(await attendance.dailyRecords(TODAY, FACTORY)).toEqual([]);

    const refused = await issueQr(lan.session);
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe('REVOKED');
  });

  it('a token past its window is denied by the server check and the snapshot', async () => {
    const lan = await onboard('BD-0003');
    const qr = await issueQr(lan.session);

    // Past TTL 60 s + tolerance 10 s; the exact boundary is in qr-token.test.ts.
    nowMs += 71_000;
    expect(await eqr.validate(qr.body.token)).toEqual({ ok: false, reason: 'EXPIRED' });
    expect((await edgeScan(qr.body.token)).reason).toBe('EXPIRED');
  });

  it('the user-session check does not block /api/edge/*, and user routes still need a session', async () => {
    expect((await request(app).get('/api/edge/snapshot')).status).toBe(200);
    expect((await push()).status).toBe(200);
    expect((await request(app).get('/api/employees')).status).toBe(401);
    expect((await request(app).post('/api/qr/token').send()).status).toBe(401);
  });

  // Blocked on unmerged work. apps/edge is only on feat/Task3 (no PR); edgeScan above stands in for it.
  it.todo('edge agent: POST /kiosk/scan validates, commits to SQLite, opens mock TCS (#24, #29)');
  it.todo(
    'edge agent: stores REVOKED, INACTIVE, UNKNOWN and the first replay of a jti as DENIED (#24)',
  );
  it.todo('edge agent: a replayed jti is denied within its TTL (#25)');
  it.todo('edge agent: pulls the snapshot and flags events stale after 5 min (#26)');
  it.todo('edge outbox: a network drop then recovery loses and duplicates nothing (#27, #30)');
  it.todo('edge agent: mock TCS timeout or error means DENIED, no attendance (#24, #30)');
  it.todo('POST /api/edge/heartbeat marks the edge online; silence raises GATE_OFFLINE (#28, #39)');
  it.todo('/api/edge/* rejects a request without a valid edge credential (#69)');
  it.todo('sync flags a stale event for a revoked person, and one jti at two edges (#33)');
  it.todo('edge outbox: does not push a PENDING event while its TCS call is still running (#27)');
  // Reporting (reporting.routes.ts, reporting.service.ts) is all stubs and has no issue or owner yet.
  it.todo('GET /api/reports/monthly reads these daily records (FR-4.1, no issue yet)');
  it.todo('monthly export sends them to MockHrs, retries, audits (FR-4.5, FR-4.6, no issue yet)');
});
