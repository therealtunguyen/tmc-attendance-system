# Kiosk scan UI (FR-2.4 / UC-1)

Open `/kiosk?gateId=<registered-gate-id>`. Missing or invalid gate configuration
blocks scanning. The main kiosk automatically opens the laptop camera and decodes
QR codes anywhere in the entire image, without a small target box. The idle view
uses a large live preview with a short guidance overlay and no title above it. Camera frames stay local and
are never uploaded. Allow camera permission once; subsequent visits start it
automatically. If permission is denied or no camera is available, the kiosk
shows a short explanation and a retry button. Camera capture requires HTTPS or
localhost/127.0.0.1. A hardware scanner types the QR token followed by Enter into an
offscreen input, focused automatically on entry and after each result. There is
no manual QR entry, virtual keypad or guard PIN on the kiosk. If scanning fails,
a guard handles the case through the separate guard/override workflow.

The UI posts `{ gateId, token }` to `/api/kiosk/scan`. Vite forwards this to
`http://127.0.0.1:3100/kiosk/scan` before its central `/api` proxy. Copy
`apps/web/.env.example` to `apps/web/.env` and set `KIOSK_EDGE_URL` to change the
dev target. Vite's proxy applies only to development; production uses the reverse
proxy described below. The optional
`VITE_KIOSK_SCAN_URL` overrides the browser endpoint at build time; direct edge
URLs need CORS/HTTPS. No employee session is sent. Device authentication belongs
to edge integration; do not put secrets in VITE variables.

The edge returns `{ result, firstName?, reason?, eventId }`. GRANTED requires a
non-empty firstName; unidentified DENIED responses may omit it. The edge owns
validation, replay protection, event storage and TCS. An eventId may represent an
unstored denial, so the UI never uses it to look up attendance.
Headlines and instructions follow the selected Vietnamese/English language.
Known DENIED reasons are shown as short translated explanations (for example,
REVOKED → “Mã đã bị thu hồi” / “Code revoked”, EXPIRED → “Mã đã hết hạn” /
“Code expired”). Missing or unknown reasons retain the guard instruction.

The UI waits up to 1.8 s, then displays an unknown result and asks for a guard.
HTTP/network/response errors are also unknown, not a fabricated DENIED decision.
Aborting a request does not undo a physical admission. The UI never retries
requests automatically; it locks during processing/results and clears names after
3 s. Late responses are ignored. Tokens are not persisted or logged by the UI.

Settings (`/kiosk/settings?gateId=<gate-id>`) offers Standard (header + scan area)
and Scan area only (minimal controls + maximized scan area). Save persists the
choice in this browser; Back and Discard changes discard unsaved choices.
The light settings screen groups display and device controls beside a layout
preview, with Save/Discard actions below. Language and front/rear camera are
draft choices until Save; the gate ID is read-only. The preview does not start a
camera or submit scans.
The key `tmc.kiosk.displayMode` stores the plain string `guided` or `scan-only`,
not JSON. Missing, corrupt or unsupported values fall back to Standard. If storage
is blocked or full, Save still applies the choice for the current page session.
Device preferences use `tmc.kiosk.language` (`vi`/`en`) and
`tmc.kiosk.cameraFacing` (`user`/`environment`), with Vietnamese/front defaults
for missing, invalid or unreadable values. The scan screen's language toggle
also persists its selection. Camera facing is an ideal constraint: if only one
camera is available, the browser can use it for either choice.

Settings is disabled during an active scan/result. Language and Settings remain
available in both layouts.
The viewport layout uses a dark background and the exact primary color
`rgb(55, 91, 200)` for the brand, scan corners and ready badge. The live camera
fills a large rounded frame. Results replace it with a large rounded green/red
card, a left-aligned icon and headline, and available employee information below.
“Response time” is the laptop's local time when the decision arrives, not an
attendance timestamp from the edge. Only the returned firstName is displayed;
the UI does not invent a full name or employee code. Vietnamese
and English reserve the same text dimensions so switching languages does not
move controls. Scanner mode requests `inputMode="none"` to avoid an OS keyboard.

Validation covers lifecycle/transport and rendered states, plus local Chrome
checks for keyboard scanner submission, language/layout stability, settings
persistence and no scrolling/clipping across desktop/tablet/mobile sizes. Previous
browser integration also exercised the edge, SQLite, TCS mock, central routes and
Prisma with temporary PGlite. Physical scanner, PostgreSQL deployment and physical
TCS/network timing still need verification before claiming the full 2 s target.

## Local QR demo

From the repository root, run `npm ci` once (Node 22+), then:

```sh
npm run demo:kiosk
```

This starts Vite on 127.0.0.1:5173 and the demo on 127.0.0.1:3100. Stop any
previous web/edge/demo processes using these ports before starting; Vite uses
`--strictPort` so it cannot silently switch away from the demo's upstream port.
Open <http://127.0.0.1:3100/> and leave the terminal running. Press Ctrl+C there
to stop both processes. No PostgreSQL, central server, login or Docker is needed.
If dependencies were installed with `--ignore-scripts`, run
`npm rebuild better-sqlite3` first to install its native binding.

Choose a scenario and click **Quét thử**. The demo simulates the hardware
scanner's input/Enter on the main kiosk in the iframe. It uses the real edge
HTTP handler, QR signature/expiry checks and SQLite replay protection, with
generated demo signing keys, two fictional employees and a mock turnstile.
The SQLite database is temporary and removed on normal shutdown. Snapshot,
outbox and heartbeat loops are not started, so demo data never reaches the
central server. Only `gate-demo` is accepted.

| Scenario                     | Expected result                              |
| ---------------------------- | -------------------------------------------- |
| Hợp lệ                       | Cho phép (GRANTED), An                       |
| Đã thu hồi                   | Từ chối, Mã đã bị thu hồi (REVOKED)          |
| Hết hạn                      | Từ chối, Mã đã hết hạn (EXPIRED)             |
| Không hợp lệ                 | Từ chối, Mã không hợp lệ (INVALID_SIGNATURE) |
| Scan the same valid QR again | Từ chối, Mã đã được sử dụng (REPLAYED)       |

Wait for the kiosk to return to idle (3 seconds) before scanning again.
Valid QR codes expire after 60 seconds; click **Tạo mã QR mới** for a fresh one.
For a physical test, connect a QR-capable scanner in USB HID/keyboard mode,
configure its suffix to Enter, click the kiosk area and scan the displayed QR
within its lifetime. The main kiosk also supports camera scanning. The **Quét thử** button simulates
scanner input; it does not optically decode the QR image.

### Phone portal and laptop camera

To act as an employee with a real phone QR, stop the old demo and run:

```sh
npm run demo:kiosk:phone
```

This demo-only command listens on the local network. The terminal prints
`Phone portal: http://<laptop-wifi-ip>:3100/portal/qr`. Connect both devices to
the same Wi-Fi and open that URL on the phone. Sign in with `an.demo` and the
sample password `DemoEmployee123!`. The existing Employee Portal requests the
employee's signed QR from the real IAM/QR services; it refreshes every 30 seconds.
Accounts and their audit log use demo memory stores; gate events use temporary SQLite.
No production database or turnstile is connected.

On the laptop, open <http://127.0.0.1:3100/kiosk?gateId=gate-demo>.
The main kiosk automatically starts the camera; allow browser camera access.
Hold the phone QR anywhere in the visible camera image. Camera frames are
locally decoded with jsQR; only the token is sent to the real edge for validation.
Each presentation is scanned once, even when the portal refreshes the QR;
remove the phone for at least a second before scanning again. The camera stays
on while results display, ready for the next person. Leaving the kiosk or opening
settings releases the camera. The old /demo/person URL redirects to this page.

The laptop camera page must use `127.0.0.1` or `localhost` (or HTTPS): browsers
do not allow camera capture on a plain HTTP LAN IP. The phone portal does not
capture camera video, so its LAN HTTP URL works for this local demo. If the phone
cannot reach the portal, check the printed Wi-Fi IP, firewall permission and
whether the Wi-Fi isolates devices.

## Production reverse proxy (Nginx)

Build with `npm ci` then `npm run build -w apps/web`. Leave
`VITE_KIOSK_SCAN_URL` unset (or empty) when building to use the same-origin
`/api/kiosk/scan` endpoint; changing a VITE variable requires rebuilding.
Copy the contents of `apps/web/dist/` to `/srv/tmc/web/` on the Nginx host.
Run the configured edge on port 3100 and central server on port 3000.
`KIOSK_EDGE_URL` does not configure production Nginx.

Put this minimal server block in the Nginx `http` context (for example,
`/etc/nginx/conf.d/tmc-kiosk.conf`). It assumes Nginx and both services run on
the same host; replace the two upstream addresses if they run elsewhere.
Camera scanning requires HTTPS when accessed outside localhost.
Port 80 is for an existing HTTPS ingress forwarding to Nginx or hardware-scanner-only use
on a trusted local network. For direct HTTPS hosting, use `listen 443 ssl` with your provisioned
`ssl_certificate` and `ssl_certificate_key` instead. Set `server_name` to your
actual hostname.

```nginx
server {
    listen 80;
    server_name kiosk.example.com;
    root /srv/tmc/web;
    index index.html;

    # Exact match wins over /api/: strip /api only for the edge scan endpoint.
    location = /api/kiosk/scan {
        proxy_pass http://127.0.0.1:3100/kiosk/scan;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_connect_timeout 1s;
        proxy_read_timeout 2s;
        proxy_next_upstream off;
        proxy_cache off;
        add_header Cache-Control "no-store" always;
    }

    # No URI suffix here: central routes retain their /api prefix.
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }

    # React Router deep links, including /kiosk/settings, load the SPA.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Validate with `sudo nginx -t`, then reload with `sudo systemctl reload nginx`.
Open `/kiosk?gateId=<registered-gate-id>` and directly reload
`/kiosk/settings?gateId=<registered-gate-id>` to confirm SPA fallback.
To check the proxy without opening the gate, send an invalid gate ID:

```sh
curl -i http://kiosk.example.com/api/kiosk/scan \
  -H 'Content-Type: application/json' \
  --data '{"gateId":"invalid/gate","token":"deployment-probe"}'
```

Expect HTTP 400 with the edge's `gateId must match` error, not SPA HTML or a
central-server 404. Use `https://` for an HTTPS deployment. Keep automatic retries
disabled for scan requests in any additional ingress/load balancer as well.
