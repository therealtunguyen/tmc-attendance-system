import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuardLanguageContext, GuardText, guardString } from './guard.i18n';

describe('guard language', () => {
  it.each([
    ['vi', 'Lý do'],
    ['en', 'Reason'],
  ] as const)(
    'exposes only the active label in %s, keeping the other translation out of label text',
    (language, expected) => {
      const html = renderToString(
        <GuardLanguageContext.Provider value={language}>
          <GuardText text="Reason" />
        </GuardLanguageContext.Provider>,
      );
      expect(html.replace(/<[^>]*>/g, '')).toBe(expected);
    },
  );
  it('keeps unknown backend messages intact', () => {
    expect(guardString('Backend detail: event-123', 'vi')).toBe('Backend detail: event-123');
  });
  it('localizes guard errors without changing the API response', () => {
    expect(guardString('Employee not found', 'vi')).toBe('Không tìm thấy nhân viên.');
    expect(guardString('Employee not found', 'en')).toBe('Employee not found');
  });
});
