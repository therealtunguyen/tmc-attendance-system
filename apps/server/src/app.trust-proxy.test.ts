import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ipFor = async (trustProxy: string | undefined) => {
  vi.resetModules();
  vi.stubEnv('TRUST_PROXY', trustProxy ?? '');
  const { createApp } = await import('./app.js');
  const { Router } = await import('express');
  const app = createApp([Router().get('/ip', (req, res) => void res.json({ ip: req.ip }))]);
  const res = await request(app).get('/api/ip').set('X-Forwarded-For', '203.0.113.7');
  return res.body.ip as string;
};

afterEach(() => vi.unstubAllEnvs());

describe('TRUST_PROXY (#113 D4)', () => {
  it('ignores X-Forwarded-For by default', async () => {
    expect(await ipFor(undefined)).not.toBe('203.0.113.7');
  });

  it('uses X-Forwarded-For for req.ip with one trusted hop', async () => {
    expect(await ipFor('1')).toBe('203.0.113.7');
  });
});
