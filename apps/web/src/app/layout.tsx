import { useEffect, useLayoutEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MeSchema } from '@portal/contracts';
import { ApiClientError } from '../lib/api';
import { safeReturnPath } from '../lib/auth';
import { useApiClient, useSession } from '../features/auth/auth-provider';
import { SignInPage } from '../features/auth/sign-in-page';
import { Button } from '../components/ui/button';

export function Layout() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [expired, setExpired] = useState(false);
  useLayoutEffect(() => { if (expired) queryClient.clear(); }, [expired, queryClient]);
  if (expired) return <main id="main-content" className="page-width"><SignInPage expired returnPath={safeReturnPath(`${location.pathname}${location.search}${location.hash}`)} /></main>;
  return <AuthenticatedLayout onExpired={() => setExpired(true)} />;
}

function AuthenticatedLayout({ onExpired }: { onExpired: () => void }) {
  const session = useSession();
  const api = useApiClient();
  const [logoutFailed, setLogoutFailed] = useState(false);
  const profile = useQuery({ queryKey: [session.sub, 'me'], queryFn: ({ signal }) => api('/me', { signal }, MeSchema), enabled: Boolean(session.sub) });
  const unauthorized = profile.error instanceof ApiClientError && profile.error.status === 401;
  useEffect(() => {
    if (unauthorized) onExpired();
  }, [unauthorized, onExpired]);
  if (profile.isPending) return <main id="main-content" className="page-width content-loading" aria-busy="true" role="status" aria-label="Loading your profile"><p className="eyebrow">Appointment portal</p><h1>Opening your workspace</h1><div className="loading-bar" /><p>Loading your profile and available services.</p></main>;
  if (profile.isError) return <main id="main-content" className="auth-panel"><h1>We could not open your workspace</h1><p role="alert">{profile.error instanceof ApiClientError ? profile.error.message : 'Please try again in a moment.'}</p><Button onClick={() => void profile.refetch()}>Try again</Button></main>;
  const me = profile.data;
  async function signOut() {
    setLogoutFailed(false);
    try { await session.signOut(); } catch { setLogoutFailed(true); }
  }
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header">
      <div className="page-width header-content">
        <NavLink to="/clinicians" className="brand" aria-label="Appointment portal home"><span aria-hidden="true" className="brand-mark">+</span><span>Appointment<span className="brand-subtitle">Patient & clinician portal</span></span></NavLink>
        <div className="account"><span>{me.displayName}<span className="account-role">{me.role === 'patient' ? 'Patient' : 'Clinician'}</span></span><Button variant="outline" onClick={() => void signOut()}>Sign out</Button></div>
      </div>
      <nav aria-label="Main navigation" className="page-width main-navigation">
        <NavLink to="/clinicians">Find a clinician</NavLink>
        <NavLink to={me.role === 'patient' ? '/appointments' : '/clinician/appointments'}>Appointments</NavLink>
        {me.role === 'clinician' && <NavLink to="/clinician/availability">Availability</NavLink>}
      </nav>
    </header>
    <main id="main-content" className="page-width page-content" tabIndex={-1}>
      {logoutFailed && <p role="alert" className="error-message">Sign-out could not finish. Please try again.</p>}
      <Outlet context={me} />
    </main>
    <footer className="page-width site-footer"><span>Appointment portal · Demonstration</span><span>Fictional information. No medical records.</span></footer>
  </div>;
}
