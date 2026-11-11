import type { EmployeeAdmission } from '../employee-qr/index.js';
import type {
  AttendanceStore,
  JtiSighting,
  StoredEvent,
  SyncReconciliation,
} from './attendance.service.js';

export type SyncAlertKind = 'STALE_ENTRY_REVOKED' | 'QR_USED_AT_TWO_EDGES';

/**
 * Where a finding goes. Reporting's Notifier fits this; it is declared here so Attendance does
 * not import Reporting, which already imports Attendance.
 */
export interface SyncAlerts {
  /** Rejects when the alert could not be handed over. */
  alert(kind: SyncAlertKind, message: string): Promise<void>;
}

/**
 * Sync reconciliation (#33). An edge decides scans on its own (ADR-9), so two things can only be
 * checked once its events reach the server:
 * - an entry granted from a snapshot older than 5 min (`stale`), for someone the server denies now;
 * - one token ID (jti) at two edges: each edge only knows the tokens it has seen itself (ADR-10).
 * Each finding is sent as an alert. Nothing stored is changed: the events stay as the edge sent them.
 */
export class SyncReconciler implements SyncReconciliation {
  constructor(
    private events: Pick<AttendanceStore, 'eventsWithJti'>,
    private admission: EmployeeAdmission,
    private alerts: SyncAlerts,
    private log: (message: string, error: unknown) => void = (m, e) => console.error(m, e),
  ) {}

  async reconcile(edgeId: string, stored: StoredEvent[]): Promise<void> {
    await this.report('STALE_ENTRY_REVOKED', edgeId, async () => {
      const lines = await this.staleEntries(stored);
      return (
        lines.length > 0 && [
          `Edge ${edgeId} synced ${count(lines.length, 'entry', 'entries')} that it granted from a snapshot older than 5 minutes, for an employee the server would deny now.`,
          'Compare each time with the time of the revocation or deactivation in the audit log: an entry after it should not have been granted.',
          ...lines,
        ]
      );
    });
    await this.report('QR_USED_AT_TWO_EDGES', edgeId, async () => {
      const lines = await this.sharedTokens(stored);
      return (
        lines.length > 0 && [
          `Edge ${edgeId} synced ${count(lines.length, 'QR token', 'QR tokens')} that another edge has also seen. A token is made for one use, so it may have been copied.`,
          ...lines,
        ]
      );
    });
  }

  /**
   * One check, one alert. The checks are separate so that one failing does not hide the other.
   * A failure is only logged: the events are stored, and both findings can be read again from
   * their `stale` and `jti` values.
   */
  private async report(
    kind: SyncAlertKind,
    edgeId: string,
    find: () => Promise<string[] | false>,
  ): Promise<void> {
    try {
      const text = await find();
      if (text) await this.alerts.alert(kind, text.join('\n'));
    } catch (error) {
      this.log(
        `Sync reconciliation: the ${kind} check of a push from edge ${edgeId} failed`,
        error,
      );
    }
  }

  /** Only GRANTED counts: a denied or pending scan let nobody in. */
  private async staleEntries(stored: StoredEvent[]): Promise<string[]> {
    const entries = stored.filter(
      (e) => e.stale && e.outcome === 'GRANTED' && e.employeeId !== null,
    );
    const employeeIds = [...new Set(entries.map((e) => e.employeeId as string))];
    const denied = new Map<string, string>();
    await Promise.all(
      employeeIds.map(async (id) => {
        const deny = await this.admission.denyOf(id);
        if (deny) denied.set(id, deny);
      }),
    );
    return entries
      .filter((e) => denied.has(e.employeeId as string))
      .map(
        (e) =>
          `- employee ${e.employeeId} (${denied.get(e.employeeId as string)} now) entered at gate ${e.gateId} at ${e.occurredAt.toISOString()} (event ${e.eventId})`,
      );
  }

  /** Read after the insert, so the new events are among the sightings. Any outcome counts as a use. */
  private async sharedTokens(stored: StoredEvent[]): Promise<string[]> {
    const jtis = [...new Set(stored.flatMap((e) => (e.jti === null ? [] : [e.jti])))];
    if (jtis.length === 0) return [];
    const byJti = new Map<string, JtiSighting[]>();
    for (const sighting of await this.events.eventsWithJti(jtis)) {
      if (sighting.jti === null) continue;
      byJti.set(sighting.jti, [...(byJti.get(sighting.jti) ?? []), sighting]);
    }
    const lines: string[] = [];
    for (const jti of jtis) {
      const sightings = byJti.get(jti) ?? [];
      if (new Set(sightings.map((s) => s.edgeId)).size < 2) continue;
      const uses = sightings.map(
        (s) =>
          `edge ${s.edgeId ?? 'none'}, gate ${s.gateId}, ${s.occurredAt.toISOString()}, ${s.outcome}, employee ${s.employeeId ?? 'unknown'}`,
      );
      lines.push(`- token ${jti}: ${uses.join('; ')}`);
    }
    return lines;
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
