# TMC Attendance

QR-code attendance and access control for TMC's two factories. Software Architecture course project (HCMUT).

The design (modules, interfaces, deployment, ADRs) is in the report: [SoftwareArchitectureReport](https://github.com/mqngyn/SoftwareArchitectureReport). This repo follows its **Logical Architecture** chapter.

## Setup

Needs Node 22 or 24 (`.nvmrc` pins 22; Node 26 fails to build `better-sqlite3@11`, which the edge uses) and Docker.

```sh
nvm use
npm install
cp .env.example .env
```

Edit `.env` before the first start (change the existing lines rather than appending new ones; with duplicates the first value wins):

- **QR signing key** (ADR-10). Run the `node -e ...` command from the comment in `.env.example`. It prints the private key (base64 PKCS8) first and the public key second. Put the private key in `QR_SIGNING_KEY` and any short name in `QR_SIGNING_KID` (e.g. `key-1`). The public key is not needed: edges get it from the snapshot. Without the key, `/api/qr/token` answers 503.
- **Edge token** (#69). The server reads comma-separated `edgeId:token` pairs, the edge reads its own token: `EDGE_TOKENS=edge-dev:change-me` on the server and `EDGE_TOKEN=change-me` for the edge. The id must equal `EDGE_ID` (default `edge-dev`). Left empty, edge sync fails closed with 401.

```sh
npm run db:up                                   # Postgres only
(cd apps/server && npx prisma migrate dev)      # create tables
npm run dev                                     # server :3000, edge :3100 (EDGE_PORT), web :5173
```

Check: <http://localhost:3000/health> returns `{ "ok": true }`, and <http://localhost:5173> shows the kiosk, portal and staff pages.

TCS (turnstiles) and HRS (HR/Payroll) are mocked in-process by default. Set `TCS_MODE=http` / `HRS_MODE=http` in `.env` to call the real systems. Mail is mocked too: set `MAIL_MODE=smtp` and `SMTP_URL` to send it.

### First data

A new database is empty, and a scan needs a user, an org unit, an edge, a gate and an employee. Do this once, with the server running. `ADM` can do all of it.

1. **Admin account.** Run from the root. Passwords need 12+ characters with a letter and a digit. HR and ADM get a TOTP secret, printed once:

   ```sh
   npm run user:create -w apps/server -- --username admin --password 'Admin-pass-1234' --role ADM
   ```

   The output has `MFA secret: <base32>` and an `otpauth URI`. Add the secret to an authenticator app (or compute codes from it). Other flags: `--employee-id`, `--scopes a,b` (org unit ids). Roles: EMP, GRD, SUP, HR, ADM, EXE.

2. **Sign in.** Log in, then send a TOTP code with the same token (it stays valid after MFA):

   ```sh
   curl -s localhost:3000/api/auth/login -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"Admin-pass-1234"}'        # copy "token"
   export ADM_TOKEN=<token>
   curl -s localhost:3000/api/auth/mfa -H "Authorization: Bearer $ADM_TOKEN" \
     -H 'Content-Type: application/json' -d '{"code":"<6-digit TOTP>"}'
   ```

3. **Org units.** A factory, then (for employees in a team) a department and a team. Ids are lowercase slugs:

   ```sh
   api() { curl -s "localhost:3000/api$1" -H "Authorization: Bearer $ADM_TOKEN" -H 'Content-Type: application/json' "${@:2}"; }
   api /org-units -d '{"id":"binh-duong","kind":"FACTORY","name":"Binh Duong","parentId":null}'
   api /org-units -d '{"id":"bd-sewing","kind":"DEPARTMENT","name":"Sewing","parentId":"binh-duong"}'
   api /org-units -d '{"id":"bd-line-1","kind":"TEAM","name":"Line 1","parentId":"bd-sewing"}'
   ```

4. **Edge row.** One per factory, and there is no API or script for it yet. `id` must equal `EDGE_ID`, `factoryId` is the factory's org unit id ([docs/gate-registry.md](docs/gate-registry.md) has the details):

   ```sh
   docker compose exec postgres psql -U tmc tmc_attendance -c \
     "INSERT INTO \"Edge\" (\"id\", \"name\", \"factoryId\") VALUES ('edge-dev', 'Edge dev', 'binh-duong');"
   ```

5. **Gate.** Copy the `id` from the response; the kiosk sends it as `gateId`:

   ```sh
   api /gates -d '{"name":"Main gate","factoryId":"binh-duong","edgeId":"edge-dev","location":"Guard house","direction":"IN","turnstileId":"turnstile-bd-01"}'
   ```

6. **Employee and their login.** Copy the employee `id`, then create an `EMP` account linked to it (an EMP has no MFA):

   ```sh
   api /employees -d '{"code":"E001","firstName":"An","lastName":"Nguyen","email":"an@example.com","factoryId":"binh-duong","teamId":"bd-line-1"}'
   npm run user:create -w apps/server -- --username an --password 'Employee-pass-1234' --role EMP --employee-id <employee id>
   ```

7. **Privacy notice** (NFR-20). Do this step last: once a notice exists, every user (the admin too) must acknowledge it before any other API call, so steps 1-6 would return `NOTICE_REQUIRED`. Publish the first one from a text file (or `PUT /api/privacy-notice` with `{"text":"..."}`):

   ```sh
   echo 'We process your attendance data under ...' > notice.txt
   npm run notice:publish -w apps/server -- ../../notice.txt   # path is relative to apps/server
   ```

   The server caches the notice for 60 s, so a running server may take up to a minute to see the first one (users get "No privacy notice has been published" until then).

### Try a scan

Log in as the employee, acknowledge the notice, and get a QR token:

```sh
curl -s localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"an","password":"Employee-pass-1234"}'            # copy "token" as EMP_TOKEN
curl -s -X POST localhost:3000/api/privacy-notice/ack -H "Authorization: Bearer $EMP_TOKEN" \
  -H 'Content-Type: application/json' -d '{"version":1}'
curl -s -X POST localhost:3000/api/qr/token -H "Authorization: Bearer $EMP_TOKEN"   # copy "token"
```

The edge refreshes its snapshot every 60 s (set `SNAPSHOT_INTERVAL_MS=5000` in `.env` to shorten it). Once it has the new employee, scan before the token expires (`ttlSeconds` in the reply):

```sh
curl -s localhost:3100/kiosk/scan -H 'Content-Type: application/json' \
  -d '{"gateId":"<gate id>","token":"<QR token>"}'
```

`GRANTED` means the edge accepted the scan and opened the (mock) turnstile. The outbox pushes the event to the server within about 5 s, where it shows up in `GET /api/access-log` (as GRD) and in the `AttendanceEvent` table. The kiosk page does the same scan with a camera.

## Scripts (run from the root)

| Script              | Does                                     |
| :------------------ | :--------------------------------------- |
| `npm run dev`       | Server, edge and web app with hot reload |
| `npm run build`     | Builds all apps                          |
| `npm run lint`      | ESLint                                   |
| `npm run format`    | Prettier, writes changes                 |
| `npm run typecheck` | `tsc --noEmit` in every app              |
| `npm test`          | Vitest in every app                      |
| `npm run db:up`     | Starts Postgres in Docker                |

## Layout

```
apps/server/            Express modular monolith
  src/main.ts           composition root: picks the concrete classes and wires them by hand
  src/app.ts            builds the Express app (used by tests without listening)
  src/modules/<name>/   iam, employee-qr, gate, attendance, reporting, admin
    index.ts            the module's public API
    <name>.service.ts   logic + the interfaces the module provides
    <name>.repo.ts      the module's own tables (Prisma)
    <name>.routes.ts    HTTP routes under /api
  src/adapters/tcs/     TurnstileClient: http.ts (real, 1 s timeout) and mock.ts
  src/adapters/hrs/     HrsClient: http.ts (real) and mock.ts
  src/adapters/mail/    Mailer: smtp.ts (real) and mock.ts
  src/shared/           env config, Prisma client, errors
  prisma/schema.prisma  database schema (starter models only)
apps/edge/              Edge agent, one per factory (ADR-9): kiosk API, SQLite, outbox sync to the server
  src/scan.ts           local-first scan flow; app.ts is POST /kiosk/scan; main.ts starts the loops
apps/web/               React + Vite single app
  src/pages/kiosk/      gate kiosk screen
  src/pages/portal/     employee portal (phone-friendly)
  src/pages/staff/      HR, supervisors, guards, admins, executives
```

Gate registry data and CRUD rules (FR-2.1): [docs/gate-registry.md](docs/gate-registry.md).

Gate online/offline monitoring and ADM alerts (FR-2.6): [docs/gate-heartbeat.md](docs/gate-heartbeat.md).

Guard access log and manual override (FR-4.4, FR-2.5 / UC-4): [docs/guard.md](docs/guard.md).

## Known limitations and assumptions

- Shifts start and end on the same Asia/Ho_Chi_Minh calendar day. A night shift across midnight shows as two missing-punch days that HR corrects.
- A day whose granted scans span less than 5 minutes (for example a double tap) has no OUT and is flagged as a missing punch with 0 h.
- With a single scan the system cannot tell IN from OUT. HR corrects `LAST_OUT` (and `FIRST_IN` if needed).
- The HRS export sends one row per employee per day: `employeeId`, `employeeCode`, `date`, `firstIn`, `lastOut`, `hours` and `missingPunch`. A missing-punch day therefore goes out with `hours` 0 and `missingPunch: true`; HRS must treat the flag, not the hours, as the sign that HR still has to correct it.
- Only `export.monthlyAt` takes effect. The other config keys are listed by `GET /api/config` (`wired: false`) but `PUT` answers 409 `CONFIG_NOT_WIRED` until a module reads them.
- Behind a reverse proxy, set `TRUST_PROXY` to the number of proxy hops so the per-IP login limiter sees the client address. Without it every request appears to come from the proxy.

## Deployment notes

The server assumes a single instance for now. These in-process caches would go stale across instances:

- the org-unit cache (invalidated only on local writes)
- the privacy-notice cache (60 s TTL), and any other in-process cache
- the per-IP login rate limiter (counts are per instance)

## Team rules

- `main` is protected. Work on a branch: `feat/<short-name>` or `fix/<short-name>`.
- Open a PR using the template. Link the requirement or use case (e.g. FR-2.3, UC-1).
- CI (lint, typecheck, test) must pass. Use **squash merge**.
- A module imports another module **only through its `index.ts`**, never its internal files. A module never reads another module's tables.
- The pre-commit hook formats and lints staged files. Don't skip it.

Manual override in HTTP mode requires `TCS_BASE_URLS=factoryId:url,...` on the central
server; `TCS_BASE_URL` is only the edge's local TCS endpoint. See
[factory routing and outage fallback](docs/gate-override.md#factory-tcs-routing-107).
