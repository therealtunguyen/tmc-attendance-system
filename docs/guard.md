# Guard page (FR-4.4, FR-2.5 / UC-4)

Open **Staff → Guard: access log and override** at `/staff/guard`. Sign in with a
GRD account. The page verifies the role through `/api/auth/me`; the server enforces
permissions and factory scope on every request. Other staff roles do not see guard
data or the override controls. Expired sessions return to sign-in.

The access log defaults to today in Vietnam time (UTC+7), newest first. Filter by
inclusive dates (at most 31 days), assigned gate or GRANTED/DENIED/PENDING outcome.
Inactive gates remain available for historical searches. The log refreshes every
15 seconds and has a **Refresh log** button. At the 500-event limit, narrow the
filters to inspect older events. Read failures replace the table with an error;
offline edge events appear only after they synchronize. Gate status is explicitly
a snapshot at page load; reload for current status.

Rows show employee code and first name, gate/factory, method, result, denial reason,
guard, override reason and event ID. The page does not request employee profiles or
contact information. If a privacy notice is awaiting acknowledgment, the page shows its current text
and requires an explicit acknowledgment before continuing. If a newer version is
published while reading, reload the notice and acknowledge that version. This also
works when a notice is published while the access log is polling.

**Manual override** requires a gate, the employee record ID supplied by HR (not the
employee code), a reason and confirmation that the guard verified the person and
gate. Guards cannot access the HR employee directory with their existing role.

- **Open gate now** sends `mode: OPEN`, using the server time. Only active gates
  can be selected. An offline edge does not itself prevent this central operation.
- **Record an earlier manual admission** sends `mode: BACKFILL` with the admission
  time interpreted in UTC+7. It can reference an inactive gate. It records an
  admission already performed by hand without sending a turnstile command.

Each submission has a fresh UUID event ID. While it is pending, submission and
cancel controls are disabled. The same form cannot submit a completed attempt
again. Definite validation rejections can be edited. Network errors, timeouts,
HTTP 409/5xx or an invalid success response are reported as **outcome unknown**:
there is no automatic retry. Use the displayed event ID to inspect the log before
starting another override. Pending or missing events need operator reconciliation.
After submission the log reloads with its current filters; adjust those filters if
the new event falls outside them (especially a historical backfill).

See [gate-override.md](gate-override.md) for API details and existing audit/attendance
transaction limitations. This page does not change the backend override contract.

The Guard console uses the same primary blue `rgb(42, 92, 206)` as the kiosk.
It is a separate signed-in staff page; it does not add a guard PIN or manual QR
entry to the public kiosk. Other portal sign-in behavior is unchanged.

Review validation: real Chrome against the auth, notice, gate, access-log and
attendance APIs with temporary PGlite/Prisma storage and TCS mock. Covered a notice
version race, factory isolation, duplicate form submission, OPEN audit/attendance,
BACKFILL of an inactive gate/employee, Vietnam date/outcome filters, TCS timeout,
a dropped response after opening, notice publication during polling, expired
sessions and non-GRD access. The audit chain verified successfully; physical TCS
and production PostgreSQL remain deployment checks.

Frontend: the header, QR brand mark, typography, white cards and controls follow
the kiosk theme. Vietnamese is the default; use the header language button for
English. Switching language retains sign-in fields, filters, override input,
confirmation and pending/result state. API values and entered reasons are never
translated. The Gate control and Access log tabs separate operations from monitoring.
Quick reasons prefill the required reason; a review dialog must be confirmed before
any override request is sent. The log supports searching loaded events by employee
code, first name or event ID; each row opens a detail drawer. No barrier position,
shift, full employee name or inferred link between separate events is fabricated. The table scrolls horizontally within its own region.

The shared portal sign-in form accepts an optional renderer for Guard labels;
its default employee-portal text and authentication behavior are preserved.

The completed frontend was rechecked in Chrome in both languages: switching
preserved the username/password, override employee/reason, confirmation checkbox
and panel/filter positions. OPEN/BACKFILL, privacy notice, scoped access and
lost-response tests still passed against the real APIs. A separate mobile check
confirmed contained horizontal table scrolling and the exact primary RGB color.
