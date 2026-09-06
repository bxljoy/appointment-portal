import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

import { SessionProvider, type Session } from '../features/auth/auth-provider';

const testSession = (sub: string): Session => ({
  sub,
  accessToken: null,
  isLoading: false,
  signIn: async () => {},
  signOut: async () => {},
});

export function renderPortalPage(
  page: ReactNode,
  { initialEntry = '/', sub = 'patient-sub' }: { initialEntry?: string; sub?: string } = {},
): RenderResult & { queryClient: QueryClient; user: UserEvent } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider session={testSession(sub)} getHeaders={() => ({})}>
          <MemoryRouter initialEntries={[initialEntry]}>{page}</MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>,
    ),
    queryClient,
    user: userEvent.setup(),
  };
}
