import { describe, expect, it } from 'vitest';
import { parseEmailList, parseMailMode } from './config.js';

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
