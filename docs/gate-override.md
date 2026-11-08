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
with guard and reason, appends a GATE_OVERRIDE audit, calls the existing TCS client
(1 s timeout, no retry), then sets GRANTED or DENIED. The event time is the server's.
An offline edge does not prevent this central API from operating.

For an admission already performed by hand during an outage, use `mode: "BACKFILL"`
and `occurredAt`, an ISO timestamp with timezone no later than the server's current
time. The employee and gate must exist but may now be inactive. This records GRANTED
and an audit without calling TCS. No frontend or edge-agent changes are included.

Success returns 201 with `{ "eventId": "...", "outcome": "GRANTED" }` (or DENIED).
A repeated eventId returns 409, including when its payload differs or the original
request is still running. It never repeats an audit or physical open.

Known limitation (TODO #45): attendance and audit writes are separate. Audit failure
or a crash before outcome update can leave PENDING; automatic retries never reopen
the gate. Such events need operator reconciliation. The existing edge batch ingest
contract is unchanged; it does not yet carry guard/reason or audit MANUAL events.
