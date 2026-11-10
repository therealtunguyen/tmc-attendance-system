import type { Mailer } from '../../adapters/mail/mailer.js';

export type AlertKind = 'EXPORT_FAILED' | 'GATE_OFFLINE';

export interface Notifier {
  /** Rejects when the alert could not be handed over, so the caller can retry (Gate's offline check does). */
  alert(kind: AlertKind, message: string): Promise<void>;
}

export interface AlertRecipients {
  hr: string[];
  adm: string[];
}

/** Who hears about what (report 5.7.2): a failed export goes to HR and ADM, an offline gate to ADM (FR-2.6). */
export const ALERT_AUDIENCE: Record<AlertKind, readonly (keyof AlertRecipients)[]> = {
  EXPORT_FAILED: ['hr', 'adm'],
  GATE_OFFLINE: ['adm'],
};

/** Alerts by email through the Mailer port (FR-4.6, FR-2.6). */
export class MailNotifier implements Notifier {
  constructor(
    private mailer: Mailer,
    private recipients: AlertRecipients,
    private log: (message: string) => void = (m) => console.error(m),
  ) {}

  async alert(kind: AlertKind, message: string): Promise<void> {
    const seen = new Set<string>();
    const to: string[] = [];
    for (const group of ALERT_AUDIENCE[kind]) {
      for (const address of this.recipients[group]) {
        const key = address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        to.push(address);
      }
    }
    if (to.length === 0) {
      // A missing setting must not crash the export job or make Gate retry forever.
      this.log(`No recipients configured for the ${kind} alert: ${message}`);
      return;
    }
    await this.mailer.send({
      to: to.join(', '),
      subject: `[TMC Attendance] ${kind}`,
      text: `${message}\n\nSent automatically by the TMC attendance system.`,
    });
  }
}
