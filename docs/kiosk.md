# Kiosk scan UI (FR-2.4 / UC-1)

Open `/kiosk?gateId=<registered-gate-id>`. Missing gate configuration blocks scanning.
The scanner must act as a keyboard and finish each QR with Enter. The input is
focused on entry and after each result; manual paste + Scan also works.

The UI posts `{ gateId, token }` to `/api/kiosk/scan`. In development, Vite forwards
this to the edge at `http://127.0.0.1:3100/kiosk/scan` (before the central `/api` proxy).
Copy `apps/web/.env.example` to `apps/web/.env` and set `KIOSK_EDGE_URL` to change
the edge host, then restart Vite. Production hosting needs the equivalent reverse
proxy; Vite's proxy only runs in development. `VITE_KIOSK_SCAN_URL` can override
the browser endpoint at build time, but direct edge URLs require CORS/HTTPS. No employee session is sent;
device authentication belongs to edge integration. Do not put secrets in VITE variables.

Expected response: `{ result: "GRANTED" | "DENIED", firstName?: string, reason?: string, eventId: string }`.
The edge generates eventId. It may identify an unstored denial, so the UI never
uses it to look up an attendance row.
GRANTED requires a non-empty firstName. DENIED can omit it for an unidentified QR.
Only the API's decision is authoritative: the browser does not validate tokens,
write attendance or open TCS. Server `/api/kiosk/scan` is currently a stub; the
working edge endpoint is a dependency of task #29. This UI does not bypass #25's
replay protection by implementing a separate central scan flow.

The UI shows Checking immediately and waits at most 1.8 s, then shows an unknown
result and asks for the guard. HTTP/network/response errors are also unknown,
not a confirmed denial. Abort does not undo a physical admission. Requests are
never retried automatically. One scan runs at a time; after 3 s the displayed name
is cleared and input becomes ready again. Late replies are ignored. Tokens are
neither persisted nor logged by the UI.

`npm test -w apps/web` tests transport, deadlines, concurrency, late replies and
rendered states. Full UC-1 latency under 2 s still needs measurement with the
actual scanner, edge, attendance storage and TCS; UI tests alone cannot certify it.

UX: Vietnamese by default with an English language switch. Status uses text, symbols
and color (blue ready/checking, green granted, red denied, amber unknown). Manual
entry is collapsed by default; the scanner input remains mounted and focusable.
`inputMode="none"` asks touch devices to suppress the OS keyboard during scanning;
manual entry switches to text input so the OS keyboard can appear. No custom
virtual keyboard is included. Actual keyboard behavior depends on the device.

Local integration checked against edge PR #79 at `92170be`: signed QR, real
SQLite, TCS mock, Vite proxy and the frontend transport/controller. GRANTED took
60 ms; the 1 s TCS timeout returned DENIED with firstName in 1,065 ms. Replayed,
revoked and invalid QR cases also passed. These measurements exclude a physical
scanner, browser rendering and real TCS/network latency; verify those for the demo.
