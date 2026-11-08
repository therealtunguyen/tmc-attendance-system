import type { Mail, Mailer } from './mailer.js';

/** In-process mail stand-in: keeps what was sent, so a demo or test can read it. */
export class MockMailer implements Mailer {
  sent: Mail[] = [];

  constructor(private failing = false) {}

  async send(mail: Mail): Promise<void> {
    if (this.failing) throw new Error('MockMailer: simulated failure');
    this.sent.push(mail);
  }
}
