import type { Mailer } from '../../adapters/mail/mailer.js';
import type { Employee, QrLinkSender } from './employee-qr.service.js';

/** The portal page that draws the live QR (apps/web). */
export const QR_PAGE_PATH = '/portal/qr';

/**
 * A link, never an image: a QR in an email would be a static copy that expires in a minute (FR-1.3, ADR-10).
 * The link holds no token or ID, so a forwarded email gives nothing away: the page asks for a sign-in.
 */
export class QrLinkMail implements QrLinkSender {
  private link: string;

  constructor(
    private mailer: Mailer,
    portalUrl: string,
  ) {
    this.link = new URL(QR_PAGE_PATH, portalUrl).href;
  }

  sendQrLink({ email, firstName }: Pick<Employee, 'email' | 'firstName'>): Promise<void> {
    return this.mailer.send({
      to: email,
      subject: 'Your TMC QR code',
      text: [
        `Hello ${firstName},`,
        '',
        'Your QR code for the factory gates is on the employee portal:',
        '',
        this.link,
        '',
        'Open this link on your phone at the gate and sign in. The code changes by itself,',
        'so a screenshot or a forwarded copy will not open the gate.',
      ].join('\n'),
    });
  }
}
