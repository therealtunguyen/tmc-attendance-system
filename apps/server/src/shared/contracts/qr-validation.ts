// QR admission check (ADR-10, FR-2.2). Shared by the server and the edge agent (#23): same rules at every gate.
// Pure: each side passes its own employee source (server: database, edge: the last snapshot).
import type { SnapshotEmployee } from './edge.js';
import { verifyQrToken, type QrPublicKeys } from './qr-token.js';

export type QrDenyReason = 'INVALID_SIGNATURE' | 'EXPIRED' | 'UNKNOWN' | 'INACTIVE' | 'REVOKED';

/**
 * jti and employeeId are returned whenever the token verified (signature and exp), so the edge can
 * check reuse and record the denial against the employee. Never for EXPIRED: an old token can be replayed.
 */
export type QrCheckResult =
  | { ok: true; employeeId: string; firstName: string; jti: string }
  | { ok: false; reason: QrDenyReason; jti?: string; employeeId?: string };

export interface QrCheckContext {
  publicKeys: QrPublicKeys;
  /** Null when the employee is not known to this side. */
  findEmployee(id: string): SnapshotEmployee | null | Promise<SnapshotEmployee | null>;
  /** Unix seconds. */
  nowS: number;
}

/**
 * Signature and exp first (no lookup for a forged token), then the employee's deny state. Not jti reuse.
 * A failing `findEmployee` rejects (fail closed): the caller maps it to 5xx and the gate never opens on an error.
 */
export const checkQrToken = async (token: string, ctx: QrCheckContext): Promise<QrCheckResult> => {
  const verified = verifyQrToken(token, ctx.publicKeys, ctx.nowS);
  if (!verified.ok) return verified;
  const { sub, jti } = verified.claims;
  const employee = await ctx.findEmployee(sub);
  if (!employee) return { ok: false, reason: 'UNKNOWN', jti, employeeId: sub };
  if (employee.deny) return { ok: false, reason: employee.deny, jti, employeeId: sub };
  return { ok: true, employeeId: employee.id, firstName: employee.firstName, jti };
};
