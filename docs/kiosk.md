# Kiosk scan UI (FR-2.4 / UC-1)

Open `/kiosk?gateId=<registered-gate-id>`. Missing or invalid gate configuration
blocks scanning. A hardware scanner types the QR token followed by Enter into an
offscreen input, focused automatically on entry and after each result. There is
no manual QR entry, virtual keypad or guard PIN on the kiosk. If scanning fails,
a guard handles the case through the separate guard/override workflow.

The UI posts `{ gateId, token }` to `/api/kiosk/scan`. Vite forwards this to
`http://127.0.0.1:3100/kiosk/scan` before its central `/api` proxy. Copy
`apps/web/.env.example` to `apps/web/.env` and set `KIOSK_EDGE_URL` to change the
dev target. Production hosting needs the equivalent reverse proxy. The optional
`VITE_KIOSK_SCAN_URL` overrides the browser endpoint at build time; direct edge
URLs need CORS/HTTPS. No employee session is sent. Device authentication belongs
to edge integration; do not put secrets in VITE variables.

The edge returns `{ result, firstName?, reason?, eventId }`. GRANTED requires a
non-empty firstName; unidentified DENIED responses may omit it. The edge owns
validation, replay protection, event storage and TCS. An eventId may represent an
unstored denial, so the UI never uses it to look up attendance.

The UI waits up to 1.8 s, then displays an unknown result and asks for a guard.
HTTP/network/response errors are also unknown, not a fabricated DENIED decision.
Aborting a request does not undo a physical admission. The UI never retries
requests automatically; it locks during processing/results and clears names after
3 s. Late responses are ignored. Tokens are not persisted or logged by the UI.

Settings (`/kiosk/settings?gateId=<gate-id>`) offers Standard (header + scan area)
and Scan area only (minimal controls + maximized scan area). Save persists the
choice in this browser; Back discards unsaved changes. Settings is disabled during
an active scan/result. Language and Settings remain available in both layouts.
The viewport layout uses the exact primary color `rgb(42, 92, 206)`. Vietnamese
and English reserve the same text dimensions so switching languages does not
move controls. Scanner mode requests `inputMode="none"` to avoid an OS keyboard.

Validation covers lifecycle/transport and rendered states, plus local Chrome
checks for keyboard scanner submission, language/layout stability, settings
persistence and no scrolling/clipping across desktop/tablet/mobile sizes. Previous
browser integration also exercised the edge, SQLite, TCS mock, central routes and
Prisma with temporary PGlite. Physical scanner, PostgreSQL deployment and physical
TCS/network timing still need verification before claiming the full 2 s target.
