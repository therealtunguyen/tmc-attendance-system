import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SnapshotEmployee } from './edge.js';
import { signQrToken } from './qr-token.js';
import { checkQrToken } from './qr-validation.js';

const key = { kid: 'k1', ...generateKeyPairSync('ed25519') };
const NOW = 1_800_000_000;

/** As the edge holds it: the last snapshot, looked up synchronously. */
const snapshot = new Map<string, SnapshotEmployee>([
  ['emp-ok', { id: 'emp-ok', firstName: 'Lan', deny: null }],
  ['emp-off', { id: 'emp-off', firstName: 'Minh', deny: 'INACTIVE' }],
  ['emp-rev', { id: 'emp-rev', firstName: 'Hoa', deny: 'REVOKED' }],
]);
const ctx = {
  publicKeys: { k1: key.publicKey },
  findEmployee: (id: string) => snapshot.get(id) ?? null,
  nowS: NOW,
};
const tokenFor = (sub: string, exp = NOW + 60) =>
  signQrToken({ sub, exp, jti: `jti-${sub}` }, key.kid, key.privateKey);

describe('checkQrToken (shared by server and edge)', () => {
  it('admits an active employee and returns the first name and jti', async () => {
    expect(await checkQrToken(tokenFor('emp-ok'), ctx)).toEqual({
      ok: true,
      employeeId: 'emp-ok',
      firstName: 'Lan',
      jti: 'jti-emp-ok',
    });
  });

  it.each([
    ['emp-off', 'INACTIVE'],
    ['emp-rev', 'REVOKED'],
    ['emp-new', 'UNKNOWN'],
  ])('denies %s as %s, keeping the jti for the event', async (sub, reason) => {
    expect(await checkQrToken(tokenFor(sub), ctx)).toEqual({
      ok: false,
      reason,
      jti: `jti-${sub}`,
    });
  });

  it('does not look up the employee when the token fails verification', async () => {
    const lookups: string[] = [];
    const watched = { ...ctx, findEmployee: (id: string) => (lookups.push(id), null) };
    expect(await checkQrToken(tokenFor('emp-ok', NOW - 11), watched)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
    expect(await checkQrToken('garbage', watched)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
    expect(lookups).toEqual([]);
  });

  it('accepts exp 10 s in the past and denies 11 s as EXPIRED', async () => {
    expect(await checkQrToken(tokenFor('emp-ok', NOW - 10), ctx)).toMatchObject({ ok: true });
    expect(await checkQrToken(tokenFor('emp-ok', NOW - 11), ctx)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('rejects when the employee lookup throws, so the gate never opens on an error', async () => {
    const failing = {
      ...ctx,
      findEmployee: async (): Promise<never> => {
        throw new Error('db down');
      },
    };
    await expect(checkQrToken(tokenFor('emp-ok'), failing)).rejects.toThrow('db down');
  });

  it('reports a bad token before the employee state, and returns no jti from it', async () => {
    expect(await checkQrToken(tokenFor('emp-rev', NOW - 11), ctx)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
    const other = generateKeyPairSync('ed25519').privateKey;
    const forged = signQrToken({ sub: 'emp-rev', exp: NOW + 60, jti: 'j' }, key.kid, other);
    expect(await checkQrToken(forged, ctx)).toEqual({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('takes the name from the employee source, not from the token', async () => {
    const renamed = {
      ...ctx,
      findEmployee: () => ({ id: 'emp-ok', firstName: 'Lan B', deny: null }),
    };
    expect(await checkQrToken(tokenFor('emp-ok'), renamed)).toMatchObject({ firstName: 'Lan B' });
  });

  it('accepts an async employee source (the server reads its database)', async () => {
    const async = { ...ctx, findEmployee: async (id: string) => snapshot.get(id) ?? null };
    expect(await checkQrToken(tokenFor('emp-rev'), async)).toMatchObject({ reason: 'REVOKED' });
  });
});
