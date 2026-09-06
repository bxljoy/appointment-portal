import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/router';
import { SessionProvider, type Session } from './auth-provider';
import { SessionLoading } from './session-loading';

const base: Session = { sub: null, accessToken: null, isLoading: false, signIn: vi.fn(async () => {}), signOut: vi.fn(async () => {}) };
it('gives the authentication loading view a focused main target', () => {
  render(<SessionLoading />);
  const main = screen.getByRole('status');
  expect(main).toHaveAttribute('id', 'main-content');
  expect(main).toHaveAttribute('tabindex', '-1');
  expect(main).toHaveFocus();
});
it.each(['/appointments', '/auth/callback', '/signed-out'])('focuses main content after loading settles on %s', async (path) => {
  const client = new QueryClient();
  const tree = (loading: boolean) => <QueryClientProvider client={client}><SessionProvider session={{ ...base, isLoading: loading }} getHeaders={() => ({})}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></SessionProvider></QueryClientProvider>;
  const { rerender } = render(tree(true));
  await act(async () => rerender(tree(false)));
  await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
});
