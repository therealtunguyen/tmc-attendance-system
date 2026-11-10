import { describe, expect, it } from 'vitest';
import type { Mail } from '../../adapters/mail/mailer.js';
import { MockMailer } from '../../adapters/mail/mock.js';
import { QR_PAGE_PATH, QrLinkMail } from './employee-qr.mail.js';

const lan = { email: 'lan@tmc.vn', firstName: 'Lan' };

const sentBy = async (portalUrl: string): Promise<Mail> => {
  const mailer = new MockMailer();
  await new QrLinkMail(mailer, portalUrl).sendQrLink(lan);
  return mailer.sent[0];
};

describe('QrLinkMail (FR-1.3)', () => {
  it('sends the link to the QR page, addressed to the employee', async () => {
    const mail = await sentBy('https://portal.tmc.vn');
    expect(mail.to).toBe('lan@tmc.vn');
    expect(mail.text).toContain('Hello Lan,');
    expect(mail.text).toContain(`https://portal.tmc.vn${QR_PAGE_PATH}`);
  });

  it('links the page apps/web serves', () => {
    expect(QR_PAGE_PATH).toBe('/portal/qr');
  });

  it.each(['https://portal.tmc.vn/', 'https://portal.tmc.vn'])(
    'builds one clean link from %s',
    async (portalUrl) => {
      const { text } = await sentBy(portalUrl);
      expect(text.match(/https?:\S+/g)).toEqual(['https://portal.tmc.vn/portal/qr']);
    },
  );

  it('carries no image, token or ID: a forwarded email gives nothing away (ADR-10)', async () => {
    const mail = await sentBy('https://portal.tmc.vn');
    expect(Object.keys(mail).sort()).toEqual(['subject', 'text', 'to']);
    expect(mail.text).not.toMatch(/<img|data:image|cid:|<svg|\?|eyJ/i);
  });

  it('refuses a malformed portal URL at startup, not on the first email', () => {
    expect(() => new QrLinkMail(new MockMailer(), 'not a url')).toThrow();
  });

  it('passes a mailer failure on', async () => {
    await expect(new QrLinkMail(new MockMailer(true), 'http://p').sendQrLink(lan)).rejects.toThrow(
      'simulated failure',
    );
  });
});
