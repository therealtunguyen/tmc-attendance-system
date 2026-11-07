import nodemailer, { type Transporter } from 'nodemailer';
import type { Mail, Mailer } from './mailer.js';

const TIMEOUTS = { connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000 };

/** Any SMTP server: `url` like smtp://user:pass@host:587 (STARTTLS) or smtps://... */
export class SmtpMailer implements Mailer {
  private transport: Transporter;

  constructor(
    url: string,
    private from: string,
  ) {
    const { hostname, port, protocol, username, password } = new URL(url);
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
