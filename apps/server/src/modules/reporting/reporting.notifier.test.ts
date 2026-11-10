import { describe, expect, it, vi } from 'vitest';
import { MockMailer } from '../../adapters/mail/mock.js';
import { MailNotifier } from './reporting.notifier.js';

const recipients = { hr: ['hr@x.vn'], adm: ['adm@x.vn'] };
const footer = '\n\nSent automatically by the TMC attendance system.';

describe('MailNotifier', () => {
  it('sends EXPORT_FAILED to HR and ADM in one mail', async () => {
    const mailer = new MockMailer();
    await new MailNotifier(mailer, recipients).alert('EXPORT_FAILED', 'HRS is down');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('hr@x.vn, adm@x.vn');
  });

  it('sends GATE_OFFLINE to ADM only, never HR', async () => {
    const mailer = new MockMailer();
    await new MailNotifier(mailer, recipients).alert('GATE_OFFLINE', 'Gate 1 is silent');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('adm@x.vn');
  });

  it('removes duplicate addresses, ignoring case', async () => {
    const mailer = new MockMailer();
    const notifier = new MailNotifier(mailer, {
      hr: ['HR@x.vn', 'a@x.vn'],
      adm: ['hr@x.vn', 'b@x.vn'],
    });
    await notifier.alert('EXPORT_FAILED', 'm');
    expect(mailer.sent[0]!.to).toBe('HR@x.vn, a@x.vn, b@x.vn');
  });

  it('uses the exact subject and text', async () => {
    const mailer = new MockMailer();
    await new MailNotifier(mailer, recipients).alert('EXPORT_FAILED', 'Month 2026-10 failed');
    expect(mailer.sent[0]).toEqual({
      to: 'hr@x.vn, adm@x.vn',
      subject: '[TMC Attendance] EXPORT_FAILED',
      text: `Month 2026-10 failed${footer}`,
    });
  });

  it('logs and resolves when nobody is configured', async () => {
    const mailer = new MockMailer();
    const log = vi.fn();
    await new MailNotifier(mailer, { hr: [], adm: [] }, log).alert('EXPORT_FAILED', 'boom');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('No recipients configured for the EXPORT_FAILED alert: boom');
    expect(mailer.sent).toHaveLength(0);
  });

  it('logs GATE_OFFLINE when only HR is configured', async () => {
    const mailer = new MockMailer();
    const log = vi.fn();
    await new MailNotifier(mailer, { hr: ['hr@x.vn'], adm: [] }, log).alert('GATE_OFFLINE', 'off');
    expect(log).toHaveBeenCalledWith('No recipients configured for the GATE_OFFLINE alert: off');
    expect(mailer.sent).toHaveLength(0);
  });

  it('rejects when the mailer fails, so the caller can retry', async () => {
    const notifier = new MailNotifier(new MockMailer(true), recipients, vi.fn());
    await expect(notifier.alert('GATE_OFFLINE', 'off')).rejects.toThrow();
  });
});
