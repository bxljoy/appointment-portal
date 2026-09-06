import { FocusMain } from '../components/ui/focus-main';
import { useEffect, useRef, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useOutletContext } from 'react-router-dom';
import type { Me, Role } from '@portal/contracts';
import { Layout } from './layout';
import { RequireSession } from '../features/auth/require-session';
import { SignInPage } from '../features/auth/sign-in-page';
import { useSession } from '../features/auth/auth-provider';
import { Button } from '../components/ui/button';
import { ClinicianDirectoryPage } from '../features/clinicians/directory-page';
import { ClinicianDetailPage } from '../features/clinicians/detail-page';
import { PatientAppointmentsPage } from '../features/appointments/patient-page';
import { ClinicianAppointmentsPage } from '../features/appointments/clinician-page';
import { ClinicianAvailabilityPage } from '../features/availability/clinician-page';

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
        <Route path="/clinicians" element={<ClinicianDirectoryPage />} />
        <Route path="/clinicians/:id" element={<ClinicianDetailPage />} />
        <Route path="/appointments" element={<RoleRoute role="patient"><PatientAppointmentsPage /></RoleRoute>} />
        <Route path="/clinician/availability" element={<RoleRoute role="clinician"><ClinicianAvailabilityPage /></RoleRoute>} />
        <Route path="/clinician/appointments" element={<RoleRoute role="clinician"><ClinicianAppointmentsPage /></RoleRoute>} />
        <Route path="*" element={<section><h1>Page not found</h1><p>This page is unavailable. Return to the clinician directory to continue.</p><Button asChild><Link to="/clinicians">Find a clinician</Link></Button></section>} />
      </Route>
    </Route>
  </Routes></>;
}
export function AppRouter() { return <BrowserRouter><AppRoutes /></BrowserRouter>; }
