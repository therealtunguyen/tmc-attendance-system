# TMC Attendance

QR-code attendance and access control for TMC's two factories. Software Architecture course project (HCMUT).

The design (modules, interfaces, deployment, ADRs) is in the report: [SoftwareArchitectureReport](https://github.com/mqngyn/SoftwareArchitectureReport). This repo follows its **Logical Architecture** chapter.

## Setup

Needs Node 22 (`.nvmrc`) and Docker.

```sh
nvm use
npm install
cp .env.example .env
npm run db:up                                   # Postgres only
(cd apps/server && npx prisma migrate dev)      # create tables
npm run dev                                     # server :3000, web :5173
```

Check: <http://localhost:3000/health> returns `{ "ok": true }`, and <http://localhost:5173> shows the kiosk, portal and staff pages.

TCS (turnstiles) and HRS (HR/Payroll) are mocked in-process by default. Set `TCS_MODE=http` / `HRS_MODE=http` in `.env` to call the real systems. Mail is mocked too: set `MAIL_MODE=smtp` and `SMTP_URL` to send it.

Edge agents authenticate to `/api/edge/*` with a shared secret (#69). Set `EDGE_TOKENS=edgeId:token,...` on the server and the matching `EDGE_TOKEN` on each edge (`.env.example` has a local pair). Left empty, edge sync fails closed with 401.

## Scripts (run from the root)

| Script              | Does                               |
| :------------------ | :--------------------------------- |
| `npm run dev`       | Server and web app with hot reload |
| `npm run build`     | Builds both apps                   |
| `npm run lint`      | ESLint                             |
| `npm run format`    | Prettier, writes changes           |
| `npm run typecheck` | `tsc --noEmit` in both apps        |
| `npm test`          | Vitest in both apps                |
| `npm run db:up`     | Starts Postgres in Docker          |

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
apps/web/               React + Vite single app
  src/pages/kiosk/      gate kiosk screen
  src/pages/portal/     employee portal (phone-friendly)
  src/pages/staff/      HR, supervisors, guards, admins, executives
```

Gate registry data and CRUD rules (FR-2.1): [docs/gate-registry.md](docs/gate-registry.md).

Gate online/offline monitoring and ADM alerts (FR-2.6): [docs/gate-heartbeat.md](docs/gate-heartbeat.md).

Guard access log and manual override (FR-4.4, FR-2.5 / UC-4): [docs/guard.md](docs/guard.md).

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
