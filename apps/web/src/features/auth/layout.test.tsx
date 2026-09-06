import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { Layout } from '../../app/layout';
import { SessionProvider, type Session } from './auth-provider';

const session: Session = { sub: 'patient', accessToken: null, isLoading: false, signIn: vi.fn(async () => {}), signOut: vi.fn(async () => {}) };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SessionProvider session={session} getHeaders={() => ({})}><MemoryRouter initialEntries={['/appointments?view=future']}><Layout /></MemoryRouter></SessionProvider></QueryClientProvider>);
  return client;
}
it('displays sign-in on a gateway 401 and clears private data', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })));
  const client = mount();
  client.setQueryData(['patient', 'appointments'], ['private']);
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(session.signIn).toHaveBeenCalledWith('/appointments?view=future');
  await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
});
it.each(['patient', 'clinician'])('uses /api/me for %s navigation', async (role) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: '10000000-0000-4000-8000-000000000001', displayName: 'Portal User', role }))));
  mount();
  expect(await screen.findByText('Portal User')).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  if (role === 'clinician') expect(screen.getByRole('link', { name: 'Availability' })).toHaveAttribute('href', '/clinician/availability');
  else expect(screen.queryByRole('link', { name: 'Availability' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Appointments' })).toHaveAttribute('href', role === 'patient' ? '/appointments' : '/clinician/appointments');
});
