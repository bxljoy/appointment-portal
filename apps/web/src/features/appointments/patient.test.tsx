import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '../../app/router';
import { renderPortalPage } from '../../test/render';

const ids = {
  patient: '10000000-0000-4000-8000-000000000001',
  clinician: '10000000-0000-4000-8000-000000000010',
  slot: '10000000-0000-4000-8000-000000000020',
  appointment: '10000000-0000-4000-8000-000000000030',
};
const me = { id: ids.patient, displayName: 'Pat Lee', role: 'patient' };
const clinician = { id: ids.clinician, displayName: 'Dr. Ada Lovelace', biography: 'Supports practical care planning.', specialty: 'Primary care', timezone: 'Europe/Stockholm' };
const slot = { id: ids.slot, clinicianId: ids.clinician, startAt: '2030-01-15T09:00:00.000Z', endAt: '2030-01-15T09:30:00.000Z', status: 'open', isBooked: false };
const appointment = { id: ids.appointment, slotId: ids.slot, clinicianId: ids.clinician, patientId: ids.patient, patientDisplayName: 'Pat Lee', clinicianDisplayName: 'Dr. Ada Lovelace', startAt: slot.startAt, endAt: slot.endAt, status: 'booked', cancelledAt: null, cancelledBy: null };

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('patient appointment journeys', () => {
  it('disables duplicate booking while the server confirms it and refreshes both lists', async () => {
    let completeBooking: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}/slots`) return Promise.resolve(response({ items: [slot], nextCursor: null }));
      if (url.pathname === '/api/appointments' && !init?.method) return Promise.resolve(response({ items: [appointment], nextCursor: null }));
      if (url.pathname === '/api/appointments' && init?.method === 'POST') return new Promise<Response>((resolve) => { completeBooking = resolve; });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${ids.clinician}?date=2030-01-15` });

    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
    completeBooking?.(response(appointment, 201));
    expect(await screen.findByText('Appointment confirmed')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([request]) => new URL(String(request), 'https://portal.test').pathname.endsWith('/slots')).length).toBeGreaterThan(1));
    await portal.user.click(screen.getByRole('link', { name: 'Appointments' }));
    expect(await screen.findByText('Upcoming appointment')).toBeInTheDocument();
  });

  it('refreshes availability and never confirms a conflicting booking', async () => {
    let slotRequests = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}/slots`) { slotRequests += 1; return Promise.resolve(response({ items: slotRequests === 1 ? [slot] : [], nextCursor: null })); }
      if (url.pathname === '/api/appointments' && init?.method === 'POST') return Promise.resolve(response({ error: { code: 'SLOT_UNAVAILABLE', message: 'This availability slot is no longer available.', requestId: 'request-2' } }, 409));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${ids.clinician}?date=2030-01-15` });
    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    await screen.findByText('This slot was just booked. Please choose another.');
    expect(screen.queryByText('Appointment confirmed')).not.toBeInTheDocument();
    await waitFor(() => expect(slotRequests).toBeGreaterThan(1));
  });

  it('requires an accessible confirmation dialog before cancelling and restores focus', async () => {
    let completeCancellation: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === '/api/appointments' && !init?.method) return Promise.resolve(response({ items: [appointment], nextCursor: null }));
      if (url.pathname === `/api/appointments/${ids.appointment}/cancel`) return new Promise<Response>((resolve) => { completeCancellation = resolve; });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/appointments' });
    const trigger = await screen.findByRole('button', { name: 'Cancel appointment with Dr. Ada Lovelace' });
    await portal.user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Cancel appointment' })).toBeInTheDocument();
    expect(completeCancellation).toBeUndefined();
    await portal.user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    completeCancellation?.(response({ ...appointment, status: 'cancelled', cancelledAt: '2029-12-01T10:00:00.000Z', cancelledBy: ids.patient }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
