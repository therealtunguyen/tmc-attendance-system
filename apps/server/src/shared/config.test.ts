import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEdgeTokens, parseEmailList, parseMailMode, positiveInt } from './config.js';

describe('parseMailMode', () => {
  it.each([
    [undefined, 'mock'],
    ['', 'mock'],
    ['mock', 'mock'],
    ['smtp', 'smtp'],
    ['SMTP', 'smtp'],
    [' Smtp ', 'smtp'],
  ])('reads %j as %s', (value, mode) => {
    expect(parseMailMode(value)).toBe(mode);
  });

  it.each(['smpt', 'http', 'true'])('stops on %j instead of silently mocking mail', (value) => {
    expect(() => parseMailMode(value)).toThrow(`MAIL_MODE must be mock or smtp, not "${value}"`);
  });
});

describe('parseEmailList', () => {
  it.each([undefined, '', '  '])('reads %j as no addresses', (value) => {
    expect(parseEmailList(value, 'K')).toEqual([]);
  });

  it('reads one address', () => {
    expect(parseEmailList('a@x.vn', 'K')).toEqual(['a@x.vn']);
  });

  it('trims items and drops empty ones', () => {
    expect(parseEmailList(' a@x.vn , b@y.vn,', 'K')).toEqual(['a@x.vn', 'b@y.vn']);
  });

  it.each(['not-an-email', 'a@b', 'a b@x.vn'])('stops on %j', (item) => {
    expect(() => parseEmailList(`ok@x.vn, ${item}`, 'ALERT_EMAILS_HR')).toThrow(
      `ALERT_EMAILS_HR has an invalid email address: "${item}"`,
    );
  });
});

describe('positiveInt', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('falls back when unset or empty', () => {
    expect(positiveInt('LIMIT_TEST', 10)).toBe(10);
    vi.stubEnv('LIMIT_TEST', '');
    expect(positiveInt('LIMIT_TEST', 10)).toBe(10);
  });

  it('reads a positive integer', () => {
    vi.stubEnv('LIMIT_TEST', '25');
    expect(positiveInt('LIMIT_TEST', 10)).toBe(25);
  });

  it.each(['10/min', 'abc', '0', '-1', '1.5'])('throws naming the variable for "%s"', (value) => {
    vi.stubEnv('LIMIT_TEST', value);
    expect(() => positiveInt('LIMIT_TEST', 10)).toThrow(/LIMIT_TEST/);
  });

  it('throws for a digit string beyond the safe integer range', () => {
    vi.stubEnv('LIMIT_TEST', '9'.repeat(400));
    expect(() => positiveInt('LIMIT_TEST', 10)).toThrow(/LIMIT_TEST/);
  });
});

describe('parseEdgeTokens', () => {
  it.each([undefined, '', '  '])('reads %j as empty map (fail closed)', (value) => {
    expect(parseEdgeTokens(value)).toEqual({});
  });

  it('parses comma-separated edgeId:token pairs (allowing colons/equals in base64/hex tokens)', () => {
    expect(parseEdgeTokens(' edge-bd : tok== , edge-la:abc:def ')).toEqual({
      'edge-bd': 'tok==',
      'edge-la': 'abc:def',
    });
  });

  it.each(['no-colon', ':secret', 'edge-bd:', 'edge-bd:  '])(
    'rejects malformed entry %j without leaking its secret value',
    (value) => {
      expect(() => parseEdgeTokens(value)).toThrow(/EDGE_TOKENS\[0\] must be "edgeId:token"/);
      expect(() => parseEdgeTokens(`edge-ok:tok,${value}`)).toThrow(
        /EDGE_TOKENS\[1\] must be "edgeId:token"/,
      );
      expect(() => parseEdgeTokens(value)).not.toThrow(/secret|no-colon/);
    },
  );

  it('rejects duplicate edgeId or duplicate token', () => {
    expect(() => parseEdgeTokens('edge-bd:a,edge-bd:b')).toThrow(/duplicate edgeId/);
    expect(() => parseEdgeTokens('edge-bd:same,edge-la:same')).toThrow(/duplicate token/);
  });
});
