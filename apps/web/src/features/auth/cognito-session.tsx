import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { createOidcSettings, completeSignin, cognitoLogoutUrl, safeReturnPath } from '../../lib/auth';
import type { CognitoConfig } from '../../lib/config';
import { SessionProvider, type Session } from './auth-provider';
import { SessionLoading } from './session-loading';
import { SignInPage } from './sign-in-page';

export function CognitoSessionProvider({ config, children }: { config: CognitoConfig; children: ReactNode }) {
  const [settings] = useState(() => createOidcSettings(config));
  return <AuthProvider {...settings} skipSigninCallback={window.location.pathname !== '/auth/callback'} onSigninCallback={completeSignin}>
    <CognitoSession config={config}>{children}</CognitoSession>
  </AuthProvider>;
}

function CognitoSession({ config, children }: { config: CognitoConfig; children: ReactNode }) {
  const auth = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => auth.events.addAccessTokenExpired(() => { void auth.removeUser(); }), [auth.events, auth.removeUser]);
  useEffect(() => {
    if (auth.error && window.location.pathname === '/auth/callback') window.history.replaceState(null, '', '/auth/callback');
  }, [auth.error]);
  const active = auth.isAuthenticated && !signingOut;
  const accessToken = active ? auth.user?.access_token ?? null : null;
  const session: Session = {
    sub: active ? auth.user?.profile.sub ?? null : null,
    accessToken,
    isLoading: auth.isLoading || signingOut,
    signIn: async (returnPath) => {
      await auth.signinRedirect({ state: { returnPath: safeReturnPath(returnPath) } });
    },
    signOut: async () => {
      setSigningOut(true);
      // The SessionProvider clears queries and blocks headers before this call.
      await auth.removeUser();
      window.location.assign(cognitoLogoutUrl(config));
    },
  };
  return <SessionProvider session={session} getHeaders={(): Record<string, string> => accessToken ? { Authorization: `Bearer ${accessToken}` } : {}}>
    {session.isLoading ? <SessionLoading /> : auth.error ? <main className="page-width"><p role="alert" className="error-message">We could not complete authentication. Please sign in again.</p><SignInPage /></main> : children}
  </SessionProvider>;
}
