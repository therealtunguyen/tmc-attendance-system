// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardPage, OverrideForm } from './GuardPage';
import { GuardLanguageContext } from './guard.i18n';
import {
  fetchAccessLog,
  fetchGuardGates,
  submitOverride,
  type GuardGate,
  type OverrideResult,
} from './guard-api';

vi.mock('./guard-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./guard-api')>()),
  fetchGuardGates: vi.fn(),
  fetchAccessLog: vi.fn(),
  submitOverride: vi.fn(),
}));
const gates: GuardGate[] = [
  { id: 'g1', name: 'Entrance', factoryId: 'bd', direction: 'IN', active: true, status: 'OFFLINE' },
  { id: 'g2', name: 'Exit', factoryId: 'bd', direction: 'OUT', active: true, status: 'ONLINE' },
];
let host: HTMLDivElement;
let root: Root;
const end = vi.fn();
const recorded = vi.fn();
const close = vi.fn();
const render = async (node: ReactNode) => {
  await act(async () => {
    root.render(node);
  });
};
const form = () => host.querySelector('form')!;
const button = (name: string, scope: ParentNode = host) => {
  const found = Array.from(scope.querySelectorAll('button')).find(
    (item) => item.textContent === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
};
const click = async (name: string) => {
  await act(async () => {
    button(name).click();
  });
};
const fill = async (selector: string, value: string) => {
  const element = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  const prototype =
    element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  });
};
const review = async () => {
  await act(async () => {
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};
const mountForm = () =>
  render(
    <OverrideForm
      gates={gates}
      token="session"
      onEnd={end}
      onRecorded={recorded}
      onClose={close}
    />,
  );
const prepare = async () => {
  await fill('[aria-label="Employee ID"]', 'employee-1');
  await click('No phone');
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  vi.mocked(fetchGuardGates).mockResolvedValue({ kind: 'ok', data: gates });
  vi.mocked(fetchAccessLog).mockResolvedValue({ kind: 'ok', data: [] });
  vi.mocked(submitOverride).mockResolvedValue({ kind: 'decided', outcome: 'GRANTED' });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('guard override interactions', () => {
  it('requires a reason, shows gate status, and Cancel never sends a command', async () => {
    await mountForm();
    expect(host.textContent).toContain('OFFLINE');
    await fill('[aria-label="Employee ID"]', 'employee-1');
    await review();
    expect(host.textContent).toContain('Choose a reason to continue.');
    expect(submitOverride).not.toHaveBeenCalled();
    await click('Cancel');
    expect(close).toHaveBeenCalledOnce();
  });
  it('locks the form in flight and sends only one request for two immediate confirmations', async () => {
    let resolve!: (value: OverrideResult) => void;
    vi.mocked(submitOverride).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await mountForm();
    await prepare();
    await review();
    expect(submitOverride).not.toHaveBeenCalled();
    const confirm = button('Confirm and open gate', host.querySelector('dialog')!);
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(submitOverride).toHaveBeenCalledTimes(1);
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () => resolve({ kind: 'decided', outcome: 'GRANTED' }));
    expect(host.querySelector('fieldset')).toBeNull();
    expect(recorded).toHaveBeenCalledOnce();
  });
  it('Next employee clears personal input, retains gate and unlocks a new independent attempt', async () => {
    await mountForm();
    await fill('[aria-label="Gate"]', 'g2');
    await prepare();
    await review();
    await click('Confirm and open gate');
    await click('Next employee');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Employee ID"]')!.value).toBe('');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Gate"]')!.value).toBe('g2');
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
    await prepare();
    await review();
    await click('Confirm and open gate');
    expect(submitOverride).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitOverride).mock.calls[0][2].eventId).not.toBe(
      vi.mocked(submitOverride).mock.calls[1][2].eventId,
    );
  });
  it('stores a canonical reason while retaining its selection across languages', async () => {
    const element = (language: 'vi' | 'en') => (
      <GuardLanguageContext.Provider value={language}>
        <OverrideForm gates={gates} token="s" onEnd={end} onRecorded={recorded} onClose={close} />
      </GuardLanguageContext.Provider>
    );
    await render(element('vi'));
    await fill('[aria-label="ID nhân viên"]', 'employee-1');
    await click('Không mang điện thoại');
    await render(element('en'));
    expect(button('No phone').getAttribute('aria-pressed')).toBe('true');
    await review();
    await click('Confirm and open gate');
    expect(vi.mocked(submitOverride).mock.calls[0][2].reason).toBe('No phone');
  });
  it('explains BACKFILL, sends the historical time, and resets to OPEN for the next employee', async () => {
    await mountForm();
    await prepare();
    await click('Record an earlier manual admission');
    expect(host.textContent).toContain('This records attendance without opening the gate.');
    await fill('[type="datetime-local"]', '2026-01-01T08:00');
    await review();
    await click('Record admission');
    expect(vi.mocked(submitOverride).mock.calls[0][2]).toMatchObject({
      mode: 'BACKFILL',
      occurredAt: '2026-01-01T01:00:00.000Z',
    });
    await click('Next employee');
    expect(host.querySelector('[type="datetime-local"]')).toBeNull();
    expect(button('Open gate')).toBeDefined();
  });
  it('does not offer Next employee or resend after an unknown result', async () => {
    vi.mocked(submitOverride).mockResolvedValue({ kind: 'unknown' });
    await mountForm();
    await prepare();
    await review();
    await click('Confirm and open gate');
    expect(host.textContent).toContain('Outcome unknown');
    expect(host.textContent).not.toContain('Next employee');
    expect(submitOverride).toHaveBeenCalledOnce();
  });
});

describe('guard console lifecycle', () => {
  const mountPage = async () => {
    localStorage.setItem(
      'tmc.session',
      JSON.stringify({ token: 's', expiresAt: new Date(Date.now() + 3600000).toISOString() }),
    );
    await render(
      <MemoryRouter>
        <GuardPage />
      </MemoryRouter>,
    );
    await click('English');
  };
  it('supports arrow/Home/End navigation and polls only the visible log without live timestamp announcements', async () => {
    await mountPage();
    expect(fetchAccessLog).not.toHaveBeenCalled();
    const control = host.querySelector<HTMLButtonElement>('#control-tab')!;
    control.focus();
    await act(async () => {
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement?.id).toBe('log-tab');
    expect(host.querySelector('#log-tab')!.getAttribute('tabindex')).toBe('0');
    expect(host.querySelector('#control-tab')!.getAttribute('tabindex')).toBe('-1');
    expect(fetchAccessLog).toHaveBeenCalledOnce();
    expect(host.querySelector('.guard-toolbar [role="status"]')).toBeNull();
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
    });
    expect(document.activeElement?.id).toBe('control-tab');
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    expect(document.activeElement?.id).toBe('log-tab');
  });
  it('shows the event ID before the response and keeps it when a signed-out response unmounts the form', async () => {
    let resolve!: (result: OverrideResult) => void;
    vi.mocked(submitOverride).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    await mountPage();
    await prepare();
    await review();
    await click('Confirm and open gate');
    const eventId = vi.mocked(submitOverride).mock.calls[0][2].eventId;
    expect(host.textContent).toContain(eventId);
    await act(async () => resolve({ kind: 'signed-out' }));
    expect(host.textContent).toContain('Sign in to monitor gates');
    expect(host.textContent).toContain(eventId);
  });
});
