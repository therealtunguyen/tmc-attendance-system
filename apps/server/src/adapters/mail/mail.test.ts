import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockMailer } from './mock.js';
import { SmtpMailer } from './smtp.js';

const mail = { to: 'lan@tmc.vn', subject: 'Your QR', text: 'Open http://portal/qr' };

describe('MockMailer', () => {
  it('keeps what was sent', async () => {
    const mailer = new MockMailer();
    await mailer.send(mail);
    expect(mailer.sent).toEqual([mail]);
  });

  it('rejects in failing mode', async () => {
    const mailer = new MockMailer(true);
    await expect(mailer.send(mail)).rejects.toThrow('simulated failure');
    expect(mailer.sent).toEqual([]);
  });
});

describe('SmtpMailer', () => {
  let server: Server;
  let url: string;
  let received: string;
  let refuse: boolean;

  /** Just enough of SMTP for a client to deliver one message. */
  const serve = (socket: Socket) => {
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (inData) {
        received += text;
        if (!text.endsWith('\r\n.\r\n')) return;
        inData = false;
        return void socket.write('250 queued\r\n');
      }
      const command = text.slice(0, 4).toUpperCase();
      if (command === 'DATA') {
        inData = true;
        return void socket.write('354 go\r\n');
      }
      if (command === 'QUIT') return void socket.end('221 bye\r\n');
      if (command === 'RCPT' && refuse) return void socket.write('550 no such user\r\n');
      socket.write('250 ok\r\n');
    });
  };

  beforeAll(async () => {
    server = createServer(serve);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `smtp://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    received = '';
    refuse = false;
  });

  it('delivers one plain-text message over SMTP', async () => {
    await new SmtpMailer(url, 'TMC Attendance <no-reply@tmc.vn>').send(mail);
    expect(received).toMatch(/^From: TMC Attendance <no-reply@tmc\.vn>\r?$/m);
    expect(received).toMatch(/^To: lan@tmc\.vn\r?$/m);
    expect(received).toMatch(/^Subject: Your QR\r?$/m);
    expect(received).toMatch(/^Content-Type: text\/plain/m);
    expect(received).toContain('Open http://portal/qr');
  });

  it('sends no multipart body, so nothing can be attached', async () => {
    await new SmtpMailer(url, 'no-reply@tmc.vn').send(mail);
    expect(received).not.toMatch(/multipart|Content-Disposition|image\//i);
  });

  it('rejects when the server refuses the recipient', async () => {
    refuse = true;
    await expect(new SmtpMailer(url, 'no-reply@tmc.vn').send(mail)).rejects.toThrow();
  });

  it.each(['', 'not a url', 'http://mail.tmc.vn', 'smtp://'])(
    'refuses SMTP_URL %j at startup, naming the variable',
    (bad) => {
      expect(() => new SmtpMailer(bad, 'no-reply@tmc.vn')).toThrow('SMTP_URL must look like');
    },
  );

  it.each(['smtp://mail.tmc.vn:587', 'smtps://u:p%40ss@mail.tmc.vn:465'])('accepts %s', (good) => {
    expect(() => new SmtpMailer(good, 'no-reply@tmc.vn')).not.toThrow();
  });

  it('rejects when the server is unreachable', async () => {
    const mailer = new SmtpMailer('smtp://localhost:1', 'no-reply@tmc.vn');
    await expect(mailer.send(mail)).rejects.toThrow();
  });
});
