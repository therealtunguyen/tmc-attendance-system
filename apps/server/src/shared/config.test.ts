import { describe, expect, it } from 'vitest';
import { parseMailMode } from './config.js';

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
