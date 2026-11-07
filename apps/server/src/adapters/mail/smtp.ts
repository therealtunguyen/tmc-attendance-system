import nodemailer, { type Transporter } from 'nodemailer';
import type { Mail, Mailer } from './mailer.js';

/** Fails at startup with the variable's name, not a bare "Invalid URL". */
const parseSmtpUrl = (url: string): URL => {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // Reported below.
  }
  if (!parsed || !['smtp:', 'smtps:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(
      'SMTP_URL must look like smtp://user:pass@host:587 or smtps://user:pass@host:465',
    );
  }
  return parsed;
};

const TIMEOUTS = { connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000 };

/** Any SMTP server: `url` like smtp://user:pass@host:587 (STARTTLS) or smtps://... */
export class SmtpMailer implements Mailer {
  private transport: Transporter;

  constructor(
    url: string,
    private from: string,
  ) {
    const { hostname, port, protocol, username, password } = parseSmtpUrl(url);
    this.transport = nodemailer.createTransport({
      host: hostname,
      port: Number(port) || undefined,
      secure: protocol === 'smtps:',
      auth: username
        ? { user: decodeURIComponent(username), pass: decodeURIComponent(password) }
        : undefined,
      ...TIMEOUTS,
    });
  }

  async send({ to, subject, text }: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text });
  }
}
