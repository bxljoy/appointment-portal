import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MeSchema } from '@portal/contracts';
import { safeReturnPath } from '../../lib/auth';
import { SessionProvider, useSession, useApiClient, type Session } from './auth-provider';
import { RequireSession } from './require-session';

const baseSession = (sub: string | null = 'first'): Session => ({ sub, accessToken: null, isLoading: false, signIn: vi.fn(async () => {}), signOut: vi.fn(async () => {}) });
const headers = () => ({});
function SignOut() { const session = useSession(); return <button onClick={() => void session.signOut()}>Sign out</button>; }

describe('session boundary', () => {
  it('removes private query and mutation data before signing out', () => {
    const client = new QueryClient();
    const session = baseSession();
    session.signOut = vi.fn(async () => { expect(client.getQueryCache().getAll()).toHaveLength(0); expect(client.getMutationCache().getAll()).toHaveLength(0); });
    render(<QueryClientProvider client={client}><SessionProvider session={session} getHeaders={headers}><SignOut /></SessionProvider></QueryClientProvider>);
    client.setQueryData(['first', 'appointments'], ['private']);
    client.getMutationCache().build(client, { mutationKey: ['private'] });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(session.signOut).toHaveBeenCalledOnce();
  });
  it('clears cache before children observe a changed identity', () => {
    const client = new QueryClient();
    const seen: unknown[] = [];
    function Observe() { const { sub } = useSession(); if (sub === 'second') seen.push(client.getQueryData(['first', 'appointments'])); return <p>{sub}</p>; }
    const tree = (session: Session) => <QueryClientProvider client={client}><SessionProvider session={session} getHeaders={headers}><Observe /></SessionProvider></QueryClientProvider>;
    const { rerender } = render(tree(baseSession()));
    client.setQueryData(['first', 'appointments'], ['private']);
    rerender(tree(baseSession('second')));
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === undefined)).toBe(true);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
  it('offers sign-in for a protected route and preserves its relative return path', () => {
    const session = baseSession(null);
    render(<QueryClientProvider client={new QueryClient()}><SessionProvider session={session} getHeaders={headers}><MemoryRouter initialEntries={['/appointments?from=2026-09-07#upcoming']}><RequireSession><p>Private appointments</p></RequireSession></MemoryRouter></SessionProvider></QueryClientProvider>);
    expect(screen.queryByText('Private appointments')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(session.signIn).toHaveBeenCalledWith('/appointments?from=2026-09-07#upcoming');
  });
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/%2f%2fevil.example', '/auth/callback?code=secret', '/signed-out', '/appointments\n'])('rejects unsafe return path %s', (path) => { expect(safeReturnPath(path)).toBe('/clinicians'); });
  it('retains valid application paths', () => { expect(safeReturnPath('/appointments?from=2026-09-07#upcoming')).toBe('/appointments?from=2026-09-07#upcoming'); });
});

it('blocks session headers synchronously when sign-out begins', async () => {
  const session = baseSession();
  let request: ReturnType<typeof useApiClient>;
  function Probe() { request = useApiClient(); return <SignOut />; }
  session.signOut = vi.fn(() => new Promise<void>(() => {}));
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: '10000000-0000-4000-8000-000000000001', displayName: 'Patient', role: 'patient' }))));
  render(<QueryClientProvider client={new QueryClient()}><SessionProvider session={session} getHeaders={() => ({ Authorization: 'Bearer fixture' })}><Probe /></SessionProvider></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await request!('/me', {}, MeSchema);
  expect(new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
});
