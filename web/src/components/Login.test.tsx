import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Login } from './Login';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function submit(token: string) {
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: token } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  });
}

describe('<Login>', () => {
  it('a wrong token shows how to fix it and keeps the user on the form', async () => {
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    respond(401, { error: 'Invalid token' });
    await submit('nope');
    expect(screen.getByRole('alert').textContent).toMatch(/doesn’t match/);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('429 counts down from Retry-After and blocks the button until then', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Login onSignedIn={() => undefined} />);
    respond(429, { error: 'Too many' }, { 'Retry-After': '3' });
    await submit('nope');
    expect(screen.getByRole('alert').textContent).toBe('Too many failed attempts. You can try again in 3 s.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', true);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByRole('alert').textContent).toMatch(/in 2 s/);
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });
    expect(screen.getByRole('alert').textContent).toBe('You can try again now.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', false);
  });

  it('421 explains VCKB_ALLOWED_HOSTS with the current host', async () => {
    render(<Login onSignedIn={() => undefined} />);
    respond(421, { error: 'Misdirected request' });
    await submit('x');
    expect(screen.getByRole('alert').textContent).toMatch(/VCKB_ALLOWED_HOSTS/);
    expect(screen.getByRole('alert').textContent).toContain(window.location.host);
  });

  it('success signs in, sends the token only in the body, and clears the field', async () => {
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    const fetch = respond(200, { expiresAt: '2026-10-07T00:00:00.000Z' });
    await submit('the-token');
    expect(onSignedIn).toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/session');
    expect(init.body).toBe(JSON.stringify({ token: 'the-token' }));
    expect(JSON.stringify(init.headers)).not.toContain('the-token');
    expect((screen.getByLabelText('Access token') as HTMLInputElement).value).toBe('');
    expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain('the-token');
  });
});
