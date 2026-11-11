import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchScan,
  KioskScanner,
  RESULT_DISPLAY_MS,
  SCAN_DEADLINE_MS,
  type Decision,
  type KioskView,
  type ScanRequest,
} from './kiosk-scan';

const request: ScanRequest = { gateId: 'gate-1', token: 'signed-token' };
const granted: Decision = { result: 'GRANTED', firstName: 'Lan', eventId: 'edge-event-1' };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('scan transport', () => {
  it('posts only the gate and token to the configured edge without employee credentials', async () => {
    vi.stubEnv('VITE_KIOSK_SCAN_URL', 'https://edge.example/kiosk/scan');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(granted)));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(await fetchScan(request, signal)).toEqual(granted);
    expect(fetch).toHaveBeenCalledWith(
      'https://edge.example/kiosk/scan',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
        signal,
        credentials: 'omit',
        cache: 'no-store',
      }),
    );
  });

  it('uses the default endpoint and accepts an unidentified denial', async () => {
    vi.stubEnv('VITE_KIOSK_SCAN_URL', '');
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"result":"DENIED","eventId":"edge-denied","reason":"INVALID_SIGNATURE"}'),
      );
    vi.stubGlobal('fetch', fetch);
    expect(await fetchScan(request, new AbortController().signal)).toEqual({
      result: 'DENIED',
      eventId: 'edge-denied',
      reason: 'INVALID_SIGNATURE',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/kiosk/scan');
  });

  it.each([
    new Response('{"result":"GRANTED","firstName":"Lan"}', { status: 500 }),
    new Response('not JSON'),
    new Response('null'),
    new Response('{"result":"OPENED"}'),
    new Response('{"result":"GRANTED"}'),
    new Response('{"result":"GRANTED","eventId":"e","firstName":" "}'),
    new Response('{"result":"DENIED","eventId":"e","firstName":123}'),
  ])('does not treat an HTTP error or malformed response as an admission', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchScan(request, new AbortController().signal)).rejects.toThrow();
  });
});

describe('kiosk scan lifecycle', () => {
  it.each([
    granted,
    { result: 'DENIED', firstName: 'An', eventId: 'edge-denied', reason: 'REVOKED' } as Decision,
  ])('shows %j then clears the personal result and permits the next scan', async (decision) => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValue(decision);
    const changed = vi.fn<(view: KioskView) => void>();
    const scanner = new KioskScanner('gate-1', changed, transport);
    await scanner.scan('  qr-one\n');
    expect(changed.mock.calls.map(([view]) => view.kind)).toEqual(['processing', 'result']);
    expect(changed).toHaveBeenLastCalledWith({ kind: 'result', decision });
    await scanner.scan('qr-two');
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESULT_DISPLAY_MS);
    expect(changed).toHaveBeenLastCalledWith({ kind: 'idle' });
    await scanner.scan('qr-two');
    expect(transport).toHaveBeenCalledTimes(2);
    const first = transport.mock.calls[0]![0] as ScanRequest;
    const second = transport.mock.calls[1]![0] as ScanRequest;
    expect(first).toEqual({ gateId: 'gate-1', token: 'qr-one' });
    expect(second).toEqual({ gateId: 'gate-1', token: 'qr-two' });
    scanner.stop();
  });

  it('ignores empty tokens, missing gate configuration and duplicate submits while pending', async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValue(granted);
    const scanner = new KioskScanner('gate-1', vi.fn(), transport);
    await scanner.scan('   ');
    await new KioskScanner('', vi.fn(), transport).scan('token');
    expect(transport).not.toHaveBeenCalled();
    await Promise.all([scanner.scan('one'), scanner.scan('two')]);
    expect(transport).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it('shows an unknown result before 2 s, aborts without retry and ignores a late grant', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Decision) => void;
    const late = new Promise<Decision>((done) => {
      resolve = done;
    });
    const transport = vi
      .fn()
      .mockReturnValueOnce(late)
      .mockResolvedValueOnce({ result: 'DENIED', eventId: 'edge-denied' });
    const changed = vi.fn();
    const scanner = new KioskScanner('gate-1', changed, transport);
    const pending = scanner.scan('one');
    await vi.advanceTimersByTimeAsync(SCAN_DEADLINE_MS - 1);
    expect(changed).toHaveBeenLastCalledWith({ kind: 'processing' });
    await vi.advanceTimersByTimeAsync(1);
    expect(SCAN_DEADLINE_MS).toBeLessThan(2000);
    expect(changed).toHaveBeenLastCalledWith({ kind: 'unknown' });
    expect(transport.mock.calls[0]![1].aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RESULT_DISPLAY_MS);
    await scanner.scan('two');
    resolve(granted);
    await pending;
    expect(changed).toHaveBeenLastCalledWith({
      kind: 'result',
      decision: { result: 'DENIED', eventId: 'edge-denied' },
    });
    scanner.stop();
  });

  it('reports network failure as unknown, never as a denied or granted admission', async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const transport = vi.fn().mockRejectedValue(new Error('Offline'));
    const scanner = new KioskScanner('gate-1', changed, transport);
    await scanner.scan('one');
    expect(changed).toHaveBeenLastCalledWith({ kind: 'unknown' });
    expect(transport).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it('aborts and stops updates and timers after leaving the page', async () => {
    vi.useFakeTimers();
    let resolve!: (value: Decision) => void;
    const transport = vi.fn().mockReturnValue(
      new Promise<Decision>((done) => {
        resolve = done;
      }),
    );
    const changed = vi.fn();
    const scanner = new KioskScanner('gate-1', changed, transport);
    const pending = scanner.scan('one');
    scanner.stop();
    expect(transport.mock.calls[0]![1].aborted).toBe(true);
    resolve(granted);
    await pending;
    await vi.runAllTimersAsync();
    await scanner.scan('two');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
