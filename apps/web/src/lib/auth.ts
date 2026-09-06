import { InMemoryWebStorage, WebStorageStateStore, type User, type UserManagerSettings } from 'oidc-client-ts';
import type { CognitoConfig } from './config';

export const safeReturnPath = (path: unknown): string => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\s]/u.test(path)) return '/clinicians';
  try {
    const url = new URL(path, window.location.origin);
    const decodedPath = decodeURIComponent(url.pathname);
    if (url.origin !== window.location.origin || /[\\\s%]/u.test(decodedPath) || decodedPath.startsWith('//')) return '/clinicians';
    if (!/^\/(clinicians(?:\/[^/]+)?|appointments|clinician\/(availability|appointments))\/?$/.test(decodedPath)) return '/clinicians';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/clinicians';
  }
};

export function createOidcSettings(config: CognitoConfig): UserManagerSettings {
  const domain = config.cognitoDomain.replace(/\/$/, '');
  return {
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid profile portal/access',
    disablePKCE: false,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: true,
    // Cognito supports refresh-token renewal, but not OIDC check-session iframes.
    monitorSession: false,
    loadUserInfo: false,
    metadata: {
      issuer: config.issuer,
      authorization_endpoint: `${domain}/oauth2/authorize`,
      token_endpoint: `${domain}/oauth2/token`,
      userinfo_endpoint: `${domain}/oauth2/userInfo`,
      jwks_uri: `${config.issuer.replace(/\/$/, '')}/.well-known/jwks.json`,
      // No generic end_session_endpoint: use cognitoLogoutUrl explicitly.
    },
  };
}

export function completeSignin(user: User | undefined): void {
  const state: unknown = user?.state;
  const returnPath = typeof state === 'object' && state !== null && 'returnPath' in state ? state.returnPath : undefined;
  window.history.replaceState(null, '', safeReturnPath(returnPath));
}

export function cognitoLogoutUrl(config: CognitoConfig): string {
  const url = new URL('/logout', config.cognitoDomain);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('logout_uri', config.logoutUri);
  return url.href;
}
