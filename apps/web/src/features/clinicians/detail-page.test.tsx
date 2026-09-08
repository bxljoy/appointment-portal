import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNavigate } from 'react-router-dom';

import { AppRoutes } from '../../app/router';
import { renderPortalPage } from '../../test/render';
import { availabilityWindowForDate } from './detail-page';

const clinician = {
  id: '10000000-0000-4000-8000-000000000010',
  displayName: 'Dr. Ada Lovelace',
  biography: 'Supports practical care planning.',
  specialty: 'Primary care',
  timezone: 'Europe/Stockholm',
};
const me = { id: '10000000-0000-4000-8000-000000000001', displayName: 'Pat Lee', role: 'patient' };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function NavigateToFollowingDate() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/clinicians/${clinician.id}?date=2030-01-16`)}>Navigate to following date</button>;
}

afterEach(() => vi.unstubAllGlobals());

describe('availability date bounds', () => {
  it.each([
    ['2024-03-31', 'Europe/Stockholm', '2024-03-30T23:00:00.000Z', '2024-03-31T22:00:00.000Z'],
    ['2024-10-27', 'Europe/Stockholm', '2024-10-26T22:00:00.000Z', '2024-10-27T23:00:00.000Z'],
    ['2024-04-07', 'Australia/Sydney', '2024-04-06T13:00:00.000Z', '2024-04-07T14:00:00.000Z'],
    ['2024-10-06', 'Australia/Sydney', '2024-10-05T14:00:00.000Z', '2024-10-06T13:00:00.000Z'],
  ])('uses a correct half-open UTC day on %s in %s', (date, timezone, from, to) => {
    expect(availabilityWindowForDate(date, timezone)).toMatchObject({ from, to, limit: 20 });
  });

  it.each(['', '2030-99-99', '2030-02-30', 'not-a-date'])('returns no query window for invalid date %s', (date) => {
    expect(() => availabilityWindowForDate(date, 'Europe/Stockholm')).not.toThrow();
    expect(availabilityWindowForDate(date, 'Europe/Stockholm')).toBeUndefined();
  });

  it('shows a validation error without requesting slots for an invalid URL date', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'https://portal.test').pathname;
      if (path === '/api/me') return Promise.resolve(response(me));
      if (path === `/api/clinicians/${clinician.id}`) return Promise.resolve(response(clinician));
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${clinician.id}?date=2030-99-99` });
    expect(await screen.findByText('Choose a valid appointment date.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([request]) => new URL(String(request), 'https://portal.test').pathname.endsWith('/slots'))).toBe(false);
  });

  it('keeps a cleared date invalid instead of silently replacing it with today', async () => {
    const slotRequests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${clinician.id}`) return Promise.resolve(response(clinician));
      if (url.pathname.endsWith('/slots')) { slotRequests.push(url); return Promise.resolve(response({ items: [], nextCursor: null })); }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${clinician.id}?date=2030-01-15` });
    await screen.findByText('No available times on this date.');
    await portal.user.clear(screen.getByLabelText('Date'));
    expect(await screen.findByText('Choose a valid appointment date.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slotRequests).toHaveLength(1);
  });

  it('does not send the previous slot cursor after Back/Forward-like URL navigation', async () => {
    const slotRequests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${clinician.id}`) return Promise.resolve(response(clinician));
      if (url.pathname.endsWith('/slots')) {
        slotRequests.push(url);
        return Promise.resolve(response({ items: [], nextCursor: url.searchParams.get('cursor') ? null : 'old-cursor' }));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<><AppRoutes /><NavigateToFollowingDate /></>, { initialEntry: `/clinicians/${clinician.id}?date=2030-01-15` });
    await screen.findByRole('button', { name: 'More available times' });
    await portal.user.click(screen.getByRole('button', { name: 'More available times' }));
    await waitFor(() => expect(slotRequests.some((url) => url.searchParams.get('cursor') === 'old-cursor')).toBe(true));
    const previousWindow = { from: slotRequests[0]?.searchParams.get('from'), to: slotRequests[0]?.searchParams.get('to') };
    const requestsBeforeNavigation = slotRequests.length;
    await portal.user.click(screen.getByRole('button', { name: 'Navigate to following date' }));
    await waitFor(() => expect(slotRequests.length).toBeGreaterThan(requestsBeforeNavigation));
    const navigatedRequests = slotRequests.slice(requestsBeforeNavigation);
    expect(navigatedRequests.some((url) => {
      const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
      return from !== null && to !== null && from !== previousWindow.from && to !== previousWindow.to;
    })).toBe(true);
    expect(navigatedRequests.every((url) => url.searchParams.get('cursor') !== 'old-cursor')).toBe(true);
  });
});
