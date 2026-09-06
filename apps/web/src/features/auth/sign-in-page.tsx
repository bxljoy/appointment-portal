import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { useSession } from './auth-provider';

export function SignInPage({ returnPath, expired = false, signedOut = false }: { returnPath?: string; expired?: boolean; signedOut?: boolean }) {
  const session = useSession();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signIn() {
    setFailed(false);
    setPending(true);
    try { await session.signIn(returnPath); }
    catch { setFailed(true); }
    finally { setPending(false); }
  }
  return <section className="auth-panel" aria-labelledby="sign-in-title">
    <p className="eyebrow">Appointment portal</p>
    <h1 id="sign-in-title">{signedOut ? 'You’re signed out' : expired ? 'Please sign in again' : 'Your next appointment starts here'}</h1>
    <p>{signedOut ? 'Your appointment information has been cleared from this browser session. Sign in whenever you’re ready to return.' : expired ? 'Your session is no longer available. Sign in to continue where you left off.' : 'Sign in to find a clinician, manage your appointments, or plan your availability.'}</p>
    {failed && <p role="alert" className="error-message">Sign-in could not start. Please try again.</p>}
    <Button onClick={() => void signIn()} disabled={pending}>{pending ? 'Opening sign-in…' : 'Sign in'}</Button>
    <p className="text-sm text-muted-foreground">New patients can create an account on the sign-in page. This portal uses fictional information for demonstration.</p>
  </section>;
}

