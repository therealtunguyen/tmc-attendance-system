// Composition root: every concrete class is chosen and wired here, by hand.
import { HrsHttpClient } from './adapters/hrs/http.js';
import { MockHrs } from './adapters/hrs/mock.js';
import { TcsHttpClient } from './adapters/tcs/http.js';
import { MockTurnstile } from './adapters/tcs/mock.js';
import { createApp } from './app.js';
import { AdminRepo, AdminService, adminRoutes } from './modules/admin/index.js';
import { AttendanceRepo, AttendanceService, attendanceRoutes } from './modules/attendance/index.js';
import {
  EmployeeQrRepo,
  EmployeeQrService,
  employeeQrRoutes,
} from './modules/employee-qr/index.js';
import { GateRepo, GateService, gateRoutes } from './modules/gate/index.js';
import { authenticate, IamRepo, IamService, iamRoutes } from './modules/iam/index.js';
import { ReportingRepo, ReportingService, reportingRoutes } from './modules/reporting/index.js';
import { config } from './shared/config.js';
import { createPrisma } from './shared/prisma.js';

const db = createPrisma(config.databaseUrl);

const turnstile =
  config.tcsMode === 'http' ? new TcsHttpClient(config.tcsBaseUrl) : new MockTurnstile('open');
const hrs = config.hrsMode === 'http' ? new HrsHttpClient(config.hrsBaseUrl) : new MockHrs();

const iam = new IamService(new IamRepo(db));
const admin = new AdminService(new AdminRepo(db), iam);
const eqr = new EmployeeQrService(new EmployeeQrRepo(db), iam, config.qrKeys);
const attendance = new AttendanceService(new AttendanceRepo(db), eqr);
const reporting = new ReportingService(new ReportingRepo(db), attendance, admin, hrs, iam);
const gate = new GateService(new GateRepo(db), eqr, attendance, turnstile, admin, reporting, iam);

const app = createApp(
  [
    iamRoutes(iam, {
      login: { max: config.authRateLimitPerMin },
      mfa: { max: config.authRateLimitPerMin },
    }),
    adminRoutes(admin),
    employeeQrRoutes(eqr),
    attendanceRoutes(attendance),
    reportingRoutes(reporting),
    gateRoutes(gate),
  ],
  { before: [authenticate(iam, admin)] },
);

app.listen(config.port, () => {
  console.log(
    `server listening on http://localhost:${config.port} (TCS ${config.tcsMode}, HRS ${config.hrsMode})`,
  );
});
