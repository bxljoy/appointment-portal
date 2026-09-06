import { lazy, Suspense, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicConfig } from '../lib/config';
import { retryQuery } from '../lib/api';
import { CognitoSessionProvider } from '../features/auth/cognito-session';
import { SessionLoading } from '../features/auth/session-loading';

const LocalSessionProvider = import.meta.env.DEV ? lazy(() => import('../features/auth/local-session')) : null;
export const createQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: { retry: retryQuery, staleTime: 30_000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

export function Providers({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>
    {config.mode === 'cognito'
      ? <CognitoSessionProvider config={config}>{children}</CognitoSessionProvider>
      : import.meta.env.DEV && LocalSessionProvider
        ? <Suspense fallback={<SessionLoading />}><LocalSessionProvider>{children}</LocalSessionProvider></Suspense>
        : <main className="auth-panel" role="alert"><h1>Portal configuration unavailable</h1><p>Please reload or contact the portal administrator.</p></main>}
  </QueryClientProvider>;
}
