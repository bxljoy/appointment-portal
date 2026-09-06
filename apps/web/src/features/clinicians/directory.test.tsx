import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '../../app/router';
import { renderPortalPage } from '../../test/render';

const clinician = {
  id: '10000000-0000-4000-8000-000000000010',
  displayName: 'Dr. Ada Lovelace',
  biography: 'Supports practical, thoughtful care planning.',
  specialty: 'Primary care',
  timezone: 'Europe/Stockholm',
};
const therapist = { ...clinician, id: '10000000-0000-4000-8000-000000000011', displayName: 'Dr. Maya Chen', specialty: 'Therapy' };
const me = { id: '10000000-0000-4000-8000-000000000001', displayName: 'Pat Lee', role: 'patient' };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('clinician directory', () => {
  it('shows a loading state before rendering filterable clinician cards', async () => {
    let resolveDirectory: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'https://portal.test').pathname;
      if (path === '/api/me') return Promise.resolve(response(me));
      if (path === '/api/clinicians') return new Promise<Response>((resolve) => { resolveDirectory = resolve; });
      throw new Error(`Unexpected request ${path}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/clinicians' });

    expect(await screen.findByText('Loading clinicians')).toBeInTheDocument();
    resolveDirectory?.(response({ items: [clinician, therapist], nextCursor: null }));
    expect(await screen.findByRole('link', { name: /Dr\. Ada Lovelace/i })).toBeInTheDocument();
    await portal.user.selectOptions(screen.getByLabelText('Specialty'), 'Therapy');
    expect(screen.queryByRole('link', { name: /Dr\. Ada Lovelace/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dr\. Maya Chen/i })).toBeInTheDocument();
  });

  it('explains empty and failed directory requests', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'https://portal.test').pathname;
      if (path === '/api/me') return Promise.resolve(response(me));
      return Promise.resolve(response({ items: [], nextCursor: null }));
    }));
    const { unmount } = renderPortalPage(<AppRoutes />, { initialEntry: '/clinicians' });
    expect(await screen.findByText('No clinicians match this filter.')).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'https://portal.test').pathname;
      if (path === '/api/me') return Promise.resolve(response(me));
      return Promise.resolve(response({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Directory unavailable', requestId: 'request-1' } }, 503));
    }));
    renderPortalPage(<AppRoutes />, { initialEntry: '/clinicians' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Directory unavailable');
  });

  it('accumulates every cursor page and disables the next-page action while it loads', async () => {
    let resolveSecond: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.searchParams.get('cursor') === 'next-page') return new Promise<Response>((resolve) => { resolveSecond = resolve; });
      return Promise.resolve(response({ items: [clinician], nextCursor: 'next-page' }));
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/clinicians?specialty=Primary%20care' });
    expect(await screen.findByRole('link', { name: /Dr\. Ada Lovelace/i })).toBeInTheDocument();
    await portal.user.click(screen.getByRole('button', { name: 'Load more clinicians' }));
    expect(screen.getByRole('button', { name: 'Load more clinicians' })).toBeDisabled();
    resolveSecond?.(response({ items: [{ ...therapist, specialty: 'Primary care' }], nextCursor: null }));
    expect(await screen.findByRole('link', { name: /Dr\. Maya Chen/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dr\. Ada Lovelace/i })).toBeInTheDocument();
  });
});
