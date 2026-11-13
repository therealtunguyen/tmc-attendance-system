import { describe, expect, it } from 'vitest';
import { CONFIG, isConfigKey, parseConfig, type ConfigKey } from './admin.config.js';

const ok = (key: ConfigKey, raw: string) => CONFIG[key].parse(raw) !== undefined;

describe('config catalogue', () => {
  it('every default is valid', () => {
    for (const key of Object.keys(CONFIG) as ConfigKey[])
      expect(ok(key, CONFIG[key].default)).toBe(true);
  });

  it('only export.monthlyAt is wired (read by reporting.schedule.ts); the rest reject writes', () => {
    const wired = (Object.keys(CONFIG) as ConfigKey[]).filter((key) => CONFIG[key].wired);
    expect(wired).toEqual(['export.monthlyAt']);
  });

  it.each([
    ['qr.ttlSeconds', '30', '300'],
    ['gate.antiPassbackSeconds', '0', '3600'],
    ['attendance.lateGraceMinutes', '0', '120'],
    ['retention.attendanceYears', '5', '20'],
    ['retention.auditMonthsOnline', '12', '120'],
  ] as const)('%s accepts %s..%s only', (key, min, max) => {
    expect(ok(key, min)).toBe(true);
    expect(ok(key, max)).toBe(true);
    expect(ok(key, String(Number(min) - 1))).toBe(false);
    expect(ok(key, String(Number(max) + 1))).toBe(false);
    for (const bad of ['', 'x', '1.5', ' 60', '6e1']) expect(ok(key, bad)).toBe(false);
  });

  it('export.monthlyAt must be HH:MM before 12:00 (FR-4.3)', () => {
    for (const good of ['00:00', '06:00', '11:59']) expect(ok('export.monthlyAt', good)).toBe(true);
    for (const bad of ['12:00', '23:30', '6:00', '06:60', '0600', '06:00:00', ''])
      expect(ok('export.monthlyAt', bad)).toBe(false);
  });

  it.each(['integration.tcsBaseUrl', 'integration.hrsBaseUrl'] as const)('%s', (key) => {
    for (const good of ['', 'http://tcs.local:8080', 'https://hrs.example.com/api'])
      expect(ok(key, good)).toBe(true);
    for (const bad of ['ftp://x.com', 'tcs.local', 'javascript:alert(1)', ' '])
      expect(ok(key, bad)).toBe(false);
  });

  it('parseConfig returns typed values and falls back to the default', () => {
    expect(parseConfig('qr.ttlSeconds', '120')).toBe(120);
    expect(parseConfig('qr.ttlSeconds', undefined)).toBe(60);
    expect(parseConfig('qr.ttlSeconds', 'garbage')).toBe(60);
    expect(parseConfig('export.monthlyAt', undefined)).toBe('06:00');
    expect(parseConfig('integration.hrsBaseUrl', undefined)).toBe('');
  });

  it('isConfigKey rejects unknown and inherited keys', () => {
    expect(isConfigKey('qr.ttlSeconds')).toBe(true);
    expect(isConfigKey('nope')).toBe(false);
    expect(isConfigKey('toString')).toBe(false);
  });
});
