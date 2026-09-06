import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserManager, type UserManagerSettings } from 'oidc-client-ts';
import { CognitoSessionProvider } from './cognito-session';
import { useSession, type Session } from './auth-provider';
import type { CognitoConfig } from '../../lib/config';

const harness = vi.hoisted(() => ({ managers: [] as UserManager[], urls: [] as string[] }));
// Keep the real OIDC provider, request generator, state store and validator. Only
// replace browser navigation so a redirect transaction can complete in jsdom.
vi.mock('react-oidc-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-oidc-context')>();
  const { UserManager } = await import('oidc-client-ts');
  const { useState, createElement } = await import('react');
  return { ...actual, AuthProvider: (props: import('react-oidc-context').AuthProviderProps) => {
    const [manager] = useState(() => {
      const manager = new UserManager(props as UserManagerSettings, {
        callback: async () => { throw new Error('Unexpected popup/iframe navigation'); },
        prepare: async () => ({ navigate: async ({ url }) => { harness.urls.push(url); return { url }; }, close: () => {} }),
      });
      harness.managers.push(manager);
      return manager;
    });
    return createElement(actual.AuthProvider, { ...props, userManager: manager });
  } };
});
const config: CognitoConfig = { mode: 'cognito', apiBaseUrl: '/api', issuer: 'https://issuer.example/pool', clientId: 'public-client', cognitoDomain: 'https://login.example', redirectUri: 'http://localhost:3000/auth/callback', logoutUri: 'http://localhost:3000/signed-out' };
let session: Session;
function Probe() { session = useSession(); return <p>{session.sub ? `Signed in: ${session.sub}` : 'Signed out'}</p>; }
function mount(client = new QueryClient()) {
  return { ...render(<QueryClientProvider client={client}><CognitoSessionProvider config={config}><Probe /></CognitoSessionProvider></QueryClientProvider>), client };
}
async function authorize(returnPath = '/appointments?view=future') {
  window.history.replaceState(null, '', '/clinicians');
  const mounted = mount();
  await screen.findByText('Signed out');
  await act(() => session.signIn(returnPath));
  const url = new URL(harness.urls.at(-1)!);
  mounted.unmount();
  return url;
}
function tokenResponse(nonce: string, expiresIn = 3600) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
  const idToken = `${encode({ alg: 'RS256' })}.${encode({ sub: 'fixture-user', iss: config.issuer, aud: config.clientId, nonce })}.fixture-signature`;
  return new Response(JSON.stringify({ access_token: 'fixture-memory-token', id_token: idToken, token_type: 'Bearer', expires_in: expiresIn, scope: 'openid profile portal/access' }), { headers: { 'Content-Type': 'application/json' } });
}
function callback(url: URL, params = 'code=fixture-code') {
  window.history.replaceState(null, '', `/auth/callback?${params}&state=${url.searchParams.get('state')}`);
}
beforeEach(() => { harness.managers.length = 0; harness.urls.length = 0; sessionStorage.clear(); localStorage.clear(); });
afterEach(async () => { cleanup(); for (const manager of harness.managers) { manager.stopSilentRenew(); await manager.events.unload(); } sessionStorage.clear(); localStorage.clear(); window.history.replaceState(null, '', '/'); });

it.each(['?code=fixture-code', '?state=orphan', '?error=access_denied&error_description=fixture-detail', '?code=&state=', '#code=fixture-code&error_description=fixture-detail'])('cleans incomplete callback %s after provider initialization', async (params) => {
  window.history.replaceState(null, '', `/auth/callback${params}`);
  mount();
  expect(window.location.search + window.location.hash).toBe(params);
  await screen.findByText('Signed out');
  await waitFor(() => expect(window.location.pathname + window.location.search + window.location.hash).toBe('/auth/callback'));
});

it('generates fresh cryptographic nonces for overlapping sign-in transactions', async () => {
  window.history.replaceState(null, '', '/clinicians');
  mount();
  await screen.findByText('Signed out');
  const random = vi.spyOn(crypto, 'getRandomValues');
  await act(async () => { await Promise.all([session.signIn('/appointments'), session.signIn('/clinician/availability')]); });
  expect(harness.urls).toHaveLength(2);
  const urls = harness.urls.map((value) => new URL(value));
  const nonces = urls.map((url) => url.searchParams.get('nonce'));
  expect(nonces[0]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(nonces[1]).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(nonces[0]).not.toBe(nonces[1]);
  expect(random.mock.calls.some(([bytes]) => bytes?.byteLength === 32)).toBe(true);
  for (let index = 0; index < urls.length; index++) {
    const state = JSON.parse((await harness.managers[0]!.settings.stateStore.get(urls[index]!.searchParams.get('state')!))!);
    expect(state.nonce).toBe(nonces[index]);
    expect(urls[index]!.searchParams.get('code_challenge_method')).toBe('S256');
  }
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(2);
});

it('rejects a mismatched ID-token nonce through the mounted provider and cleans the callback', async () => {
  const request = await authorize();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse('wrong-nonce')));
  callback(request);
  const processCallback = vi.spyOn(UserManager.prototype, 'signinCallback');
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete authentication');
  await expect(processCallback.mock.results[0]?.value).rejects.toThrow('nonce in id_token does not match nonce in client storage');
  expect(screen.getByRole('main')).toHaveFocus();
  expect(screen.queryByText('Signed in: fixture-user')).not.toBeInTheDocument();
  expect(await harness.managers.at(-1)!.getUser()).toBeNull();
  expect(window.location.search).toBe('');
  expect(sessionStorage.length).toBe(0);
});

it('does not strip a valid callback while token exchange is pending and restores the safe return path', async () => {
  const request = await authorize();
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  callback(request);
  mount();
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(screen.getByRole('status', { name: 'Loading session' })).toHaveFocus();
  expect(window.location.search).toContain('code=fixture-code');
  expect(window.location.search).toContain('state=');
  await act(async () => resolve(tokenResponse(request.searchParams.get('nonce') ?? 'baseline-no-nonce')));
  await screen.findByText('Signed in: fixture-user');
  expect(window.location.pathname + window.location.search).toBe('/appointments?view=future');
  expect(sessionStorage.length).toBe(0);
});

it('processes a valid OAuth error before removing its callback parameters', async () => {
  const request = await authorize();
  vi.stubGlobal('fetch', vi.fn());
  callback(request, 'error=access_denied&error_description=fixture-detail');
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete authentication');
  expect(window.location.pathname + window.location.search).toBe('/auth/callback');
  expect(sessionStorage.length).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('clears the user and private cache when the library expires the access token', async () => {
  const request = await authorize();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse(request.searchParams.get('nonce') ?? 'baseline-no-nonce')));
  callback(request);
  const { client } = mount();
  await screen.findByText('Signed in: fixture-user');
  client.setQueryData(['fixture-user', 'appointments'], ['private']);
  const manager = harness.managers.at(-1)!;
  manager.stopSilentRenew();
  const user = (await manager.getUser())!;
  user.expires_in = 1;
  await act(async () => { await manager.events.load(user); });
  await waitFor(() => expect(screen.getByText('Signed out')).toBeInTheDocument(), { timeout: 3000 });
  expect(await manager.getUser()).toBeNull();
  expect(client.getQueryCache().getAll()).toHaveLength(0);
});
