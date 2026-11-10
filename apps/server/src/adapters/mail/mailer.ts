/**
 * Plain text, on purpose: there is no field for HTML or an attachment, so no adapter
 * can send a QR image. The email carries a link to the live page instead (FR-1.3, ADR-10).
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Rejects when the mail could not be handed over. */
  send(mail: Mail): Promise<void>;
}
