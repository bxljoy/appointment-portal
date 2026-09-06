import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createApiClient, type ApiRequest } from '../../lib/api';
import { SessionLoading } from './session-loading';

export type Session = {
  sub: string | null;
  accessToken: string | null;
  isLoading: boolean;
  signIn(returnPath?: string): Promise<void>;
  signOut(): Promise<void>;
};
const SessionContext = createContext<Session | null>(null);
const ApiContext = createContext<ApiRequest | null>(null);

export function SessionProvider({ session, getHeaders, children }: { session: Session; getHeaders: () => Record<string, string>; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [settledSub, setSettledSub] = useState<string | null | undefined>(undefined);
  const blocked = useRef(false);
  const currentHeaders = useRef(getHeaders);
  currentHeaders.current = getHeaders;
  useLayoutEffect(() => {
    if (settledSub !== session.sub) {
      queryClient.clear();
      blocked.current = false;
      setSettledSub(session.sub);
    }
  }, [queryClient, session.sub, settledSub]);
  const api = useMemo(() => createApiClient(() => blocked.current ? {} : currentHeaders.current()), []);
  const value = useMemo<Session>(() => ({
    ...session,
    signOut: async () => {
      blocked.current = true;
      queryClient.clear();
      await session.signOut();
    },
  }), [session, queryClient]);
  if (settledSub !== session.sub) return <SessionLoading />;
  return <SessionContext.Provider value={value}><ApiContext.Provider value={api}>{children}</ApiContext.Provider></SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('SessionProvider is required');
  return session;
}
export function useApiClient(): ApiRequest {
  const api = useContext(ApiContext);
  if (!api) throw new Error('SessionProvider is required');
  return api;
}
