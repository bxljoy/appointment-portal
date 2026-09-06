import './local-session.css';
import { useState, type ReactNode } from 'react';
import { safeReturnPath } from '../../lib/auth';
import { SessionProvider, type Session } from './auth-provider';

// LOCAL_AUTH_DEVELOPMENT_ONLY: this entire module must be absent from production.
const identities = [
  ['patient-a', 'Alice Patient'],
  ['patient-b', 'Bea Patient'],
  ['clinician-a', 'Casey Clinician'],
  ['clinician-b', 'Devon Clinician'],
] as const;

export default function LocalSessionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<string>(identities[0][0]);
  const [sub, setSub] = useState<string | null>(null);
  const session: Session = {
    sub,
    accessToken: null,
    isLoading: false,
    signIn: async (returnPath) => {
      setSub(selected);
      window.history.replaceState(null, '', safeReturnPath(returnPath));
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    signOut: async () => {
      setSub(null);
      window.history.replaceState(null, '', '/signed-out');
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
  };
  return <SessionProvider session={session} getHeaders={(): Record<string, string> => sub ? { 'X-Local-Actor': sub } : {}}>
    <aside aria-label="Development authentication" className="dev-toolbar">
      <label htmlFor="local-identity">Development identity</label>
      <select id="local-identity" value={selected} onChange={(event) => { setSelected(event.target.value); if (sub) setSub(event.target.value); }}>
        {identities.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </aside>
    {children}
  </SessionProvider>;
}
