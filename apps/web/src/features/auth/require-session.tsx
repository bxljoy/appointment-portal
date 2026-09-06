import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { safeReturnPath } from '../../lib/auth';
import { useSession } from './auth-provider';
import { SessionLoading } from './session-loading';
import { SignInPage } from './sign-in-page';

export function RequireSession({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.isLoading) return <SessionLoading />;
  if (!session.sub) return <main id="main-content" className="page-width"><SignInPage returnPath={safeReturnPath(`${location.pathname}${location.search}${location.hash}`)} /></main>;
  return children;
}
