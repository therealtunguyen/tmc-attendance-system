import { afterEach, describe, expect, it, vi } from 'vitest';
import { positiveInt } from './config.js';

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
});
