import { FocusMain } from '../components/ui/focus-main';
import { useEffect, useRef, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useOutletContext } from 'react-router-dom';
import type { Me, Role } from '@portal/contracts';
import { Layout } from './layout';
import { RequireSession } from '../features/auth/require-session';
import { SignInPage } from '../features/auth/sign-in-page';
import { useSession } from '../features/auth/auth-provider';
import { Button } from '../components/ui/button';

function RouteFocus() {
  const location = useLocation();
  const previous = useRef(location.pathname);
  useEffect(() => {
    if (previous.current !== location.pathname) document.getElementById('main-content')?.focus();
    previous.current = location.pathname;
  }, [location.pathname]);
  return null;
}
function RoleRoute({ role, children }: { role: Role; children: ReactNode }) {
  const me = useOutletContext<Me>();
  if (me.role !== role) return <section><h1>This page is for {role === 'clinician' ? 'clinicians' : 'patients'}</h1><p>Your account does not have access to this workspace.</p><Button asChild><Link to="/clinicians">Find a clinician</Link></Button></section>;
  return children;
}
function RouteIntroduction({ title, description }: { title: string; description: string }) {
  return <section className="route-introduction"><p className="eyebrow">Appointment portal</p><h1>{title}</h1><p>{description}</p><div className="care-note"><span className="care-note-label">Plan your visit</span><p>Each appointment lasts 30 minutes. Times are displayed in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p></div></section>;
}
function SignedOutPage() {
  const session = useSession();
  return session.sub ? <Navigate to="/clinicians" replace /> : <FocusMain className="page-width"><SignInPage signedOut /></FocusMain>;
}
function CallbackPage() {
  const session = useSession();
  return session.sub ? <Navigate to="/clinicians" replace /> : <FocusMain className="page-width"><SignInPage /></FocusMain>;
}
export function AppRoutes() {
  return <><RouteFocus /><Routes>
    <Route path="/auth/callback" element={<CallbackPage />} />
    <Route path="/signed-out" element={<SignedOutPage />} />
    <Route element={<RequireSession><Outlet /></RequireSession>}>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/clinicians" replace />} />
        <Route path="/clinicians" element={<RouteIntroduction title="Find a clinician" description="Explore clinicians and choose a time that works for you." />} />
        <Route path="/clinicians/:id" element={<RouteIntroduction title="Plan an appointment" description="Review your clinician’s profile and upcoming availability." />} />
        <Route path="/appointments" element={<RoleRoute role="patient"><RouteIntroduction title="Your appointments" description="Keep track of upcoming visits and your appointment history." /></RoleRoute>} />
        <Route path="/clinician/availability" element={<RoleRoute role="clinician"><RouteIntroduction title="Your availability" description="Publish appointment times and manage your open slots." /></RoleRoute>} />
        <Route path="/clinician/appointments" element={<RoleRoute role="clinician"><RouteIntroduction title="Your appointments" description="Review scheduled visits and manage your upcoming appointments." /></RoleRoute>} />
        <Route path="*" element={<section><h1>Page not found</h1><p>This page is unavailable. Return to the clinician directory to continue.</p><Button asChild><Link to="/clinicians">Find a clinician</Link></Button></section>} />
      </Route>
    </Route>
  </Routes></>;
}
export function AppRouter() { return <BrowserRouter><AppRoutes /></BrowserRouter>; }
