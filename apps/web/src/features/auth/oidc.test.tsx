import { User, UserManager, OidcClient } from 'oidc-client-ts';
import { expect, it, vi } from 'vitest';
import { completeSignin, createOidcSettings, cognitoLogoutUrl } from '../../lib/auth';
import type { CognitoConfig } from '../../lib/config';

const config: CognitoConfig = { mode: 'cognito', apiBaseUrl: '/api', issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/pool', clientId: 'publicclient', cognitoDomain: 'https://portal.auth.eu-north-1.amazoncognito.com', redirectUri: 'https://portal.example/auth/callback', logoutUri: 'https://portal.example/signed-out' };
const user = (state?: unknown) => new User({ access_token: 'fixture-memory-only', token_type: 'Bearer', profile: { sub: 'fixture', iss: config.issuer, aud: config.clientId, exp: 9999999999, iat: 1 }, userState: state });

it('uses the OIDC library to generate authorization code + S256 PKCE redirect state', async () => {
  const settings = createOidcSettings(config);
  const client = new OidcClient(settings);
  const request = await client.createSigninRequest({ state: { returnPath: '/appointments' } });
  const url = new URL(request.url);
  expect(url.origin).toBe(config.cognitoDomain);
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('scope')).toBe('openid profile portal/access');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  expect(url.searchParams.has('client_secret')).toBe(false);
  const stored = JSON.parse((await settings.stateStore!.get(request.state.id))!);
  expect(stored.data).toEqual({ returnPath: '/appointments' });
  expect(stored.code_verifier).toBeTruthy();
  await settings.stateStore!.remove(request.state.id);
});
it('keeps users/tokens in library memory and never persists them in browser storage', async () => {
  const sessionSet = vi.spyOn(Storage.prototype, 'setItem');
  const settings = createOidcSettings(config);
  const manager = new UserManager(settings);
  await manager.storeUser(user());
  expect((await manager.getUser())?.access_token).toBe('fixture-memory-only');
  expect(sessionSet).not.toHaveBeenCalled();
  const freshManager = new UserManager(createOidcSettings(config));
  expect(await freshManager.getUser()).toBeNull();
  await manager.removeUser();
  expect(await manager.getUser()).toBeNull();
});
it('removes callback parameters and restores only a validated relative destination', () => {
  window.history.replaceState(null, '', '/auth/callback?code=fixture&state=fixture');
  completeSignin(user({ returnPath: '/appointments?view=future' }));
  expect(window.location.pathname + window.location.search).toBe('/appointments?view=future');
  window.history.replaceState(null, '', '/auth/callback?code=fixture&state=fixture');
  completeSignin(user({ returnPath: '//evil.example' }));
  expect(window.location.pathname).toBe('/clinicians');
  expect(window.location.search).toBe('');
});
it('uses Cognito logout parameters without generic OIDC end-session semantics', () => {
  const url = new URL(cognitoLogoutUrl(config));
  expect(url.origin + url.pathname).toBe(`${config.cognitoDomain}/logout`);
  expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: config.clientId, logout_uri: config.logoutUri });
  expect(createOidcSettings(config).metadata?.end_session_endpoint).toBeUndefined();
});
