import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMailMode, positiveInt } from './config.js';

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
