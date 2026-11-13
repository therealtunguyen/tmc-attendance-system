# Manual override (FR-2.5 / UC-4)

`POST /api/gates/:gateId/override` requires a signed-in GRD with `gate:override`
and scope covering the gate's factory. The guard identity comes from the session.

```json
{
  "eventId": "client-generated-uuid",
  "employeeId": "employee-id",
  "reason": "Phone broken",
  "mode": "OPEN"
}
```

`OPEN` requires an active gate and employee. The server saves a MANUAL/PENDING event
with guard and reason, appends a GATE_OVERRIDE audit, calls the TCS client configured for the gate's factory
(1 s timeout, no retry), then sets GRANTED or DENIED. The event time is the server's.
An offline edge does not prevent this central API from operating, but the central
server and the factory VPN/TCS must be reachable. During a central/VPN outage,
the guard admits the employee by hand using the paper fallback, then records a
BACKFILL after recovery.

For an admission already performed by hand during an outage, use `mode: "BACKFILL"`
and `occurredAt`, an ISO timestamp with timezone no later than the server's current
time. The employee and gate must exist but may now be inactive. This records GRANTED
and an audit without calling TCS. The [Guard page](guard.md) supports both modes;
the edge-agent contract is unchanged.

Success returns 201 with `{ "eventId": "...", "outcome": "GRANTED" }` (or DENIED).
A repeated eventId returns 409, including when its payload differs or the original
request is still running. It never repeats an audit or physical open.

Known limitation (TODO #45): attendance and audit writes are separate. Audit failure
or a crash before outcome update can leave PENDING; automatic retries never reopen
the gate. Such events need operator reconciliation. The existing edge batch ingest
contract is unchanged; it does not yet carry guard/reason or audit MANUAL events.

## Factory TCS routing (#107)

The central server uses `TCS_MODE=http` and `TCS_BASE_URLS`, for example:

```dotenv
TCS_MODE=http
TCS_BASE_URLS=binh-duong:http://10.1.0.2:4001,long-an:http://10.2.0.2:4001
```

Use registered factory IDs. Each base URL must be HTTP(S), without credentials,
query or fragment; path prefixes and ports are supported. Malformed entries and
duplicate factory IDs stop startup. Empty entries are ignored. Restart the server
after changing this environment mapping. Mock mode uses an in-process mock for
all factories and requires no endpoints; HTTP mode never falls back to a mock or
to `TCS_BASE_URL`.

`OPEN` resolves the client using the stored gate's `factoryId`, before writing
attendance or audit. An unmapped factory returns 503 (`No TCS configured for this
factory`) without consuming the event ID or leaving PENDING. A configured TCS
that fails or times out still produces the existing audited DENIED outcome;
there is no retry. `BACKFILL` does not resolve or call any TCS.

`TCS_BASE_URL` remains the edge agent's local endpoint for normal QR scans.
The reserved, unwired admin key `integration.tcsBaseUrl` does not configure manual
override; its writes remain rejected. Routing changes neither the database schema
nor the existing globally unique `turnstileId` registry rule.
