import { FocusMain } from '../../components/ui/focus-main';
export function SessionLoading() {
  return <FocusMain role="status" aria-label="Loading session" aria-busy="true" className="auth-panel"><p className="eyebrow">Appointment portal</p><h1>Getting your session ready</h1><p>Please wait while we connect you to your appointments.</p><div className="loading-bar" /></FocusMain>;
}
