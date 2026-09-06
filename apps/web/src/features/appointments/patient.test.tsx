import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Appointment } from '@portal/contracts';

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
const appointment: Appointment = { id: ids.appointment, slotId: ids.slot, clinicianId: ids.clinician, patientId: ids.patient, patientDisplayName: 'Pat Lee', clinicianDisplayName: 'Dr. Ada Lovelace', startAt: slot.startAt, endAt: slot.endAt, status: 'booked', cancelledAt: null, cancelledBy: null };

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
    portal.queryClient.setQueryData(['patient-sub', 'appointments', 'first'], { items: [], nextCursor: null });

    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
    completeBooking?.(response(appointment, 201));
    expect(await screen.findByText('Appointment confirmed')).toBeInTheDocument();
    expect(portal.queryClient.getQueryState(['patient-sub', 'appointments', 'first'])?.isInvalidated).toBe(true);
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

  it('reconciles a direct-first-visit network failure before showing confirmation', async () => {
    let appointmentsReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}/slots`) return Promise.resolve(response({ items: [slot], nextCursor: null }));
      if (url.pathname === '/api/appointments' && init?.method === 'POST') return Promise.reject(new TypeError('offline'));
      if (url.pathname === '/api/appointments') { appointmentsReads += 1; return Promise.resolve(response({ items: [appointment], nextCursor: null })); }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${ids.clinician}?date=2030-01-15` });
    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByText('Appointment confirmed')).toBeInTheDocument();
    expect(appointmentsReads).toBe(1);
  });

  it('reconciles every appointment cursor page until it finds the selected booking', async () => {
    const matchingAppointment = { ...appointment, id: '10000000-0000-4000-8000-000000000032' };
    let appointmentsReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}/slots`) return Promise.resolve(response({ items: [slot], nextCursor: null }));
      if (url.pathname === '/api/appointments' && init?.method === 'POST') return Promise.reject(new TypeError('offline'));
      if (url.pathname === '/api/appointments') {
        appointmentsReads += 1;
        return Promise.resolve(response(url.searchParams.get('cursor') === 'later' ? { items: [matchingAppointment], nextCursor: null } : { items: [], nextCursor: 'later' }));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${ids.clinician}?date=2030-01-15` });
    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByText('Appointment confirmed')).toBeInTheDocument();
    expect(appointmentsReads).toBe(2);
  });

  it('blocks a blind duplicate retry when network reconciliation also fails', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}/slots`) return Promise.resolve(response({ items: [slot], nextCursor: null }));
      if (url.pathname === '/api/appointments' && init?.method === 'POST') return Promise.reject(new TypeError('offline'));
      if (url.pathname === '/api/appointments') return Promise.reject(new TypeError('offline'));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${ids.clinician}?date=2030-01-15` });
    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByText('We could not determine whether your booking was created.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open your appointments' })).toBeInTheDocument();
  });

  it('fails safely when appointment reconciliation repeats a cursor', async () => {
    let appointmentsReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}/slots`) return Promise.resolve(response({ items: [slot], nextCursor: null }));
      if (url.pathname === '/api/appointments' && init?.method === 'POST') return Promise.reject(new TypeError('offline'));
      if (url.pathname === '/api/appointments') { appointmentsReads += 1; return Promise.resolve(response({ items: [], nextCursor: 'repeated' })); }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${ids.clinician}?date=2030-01-15` });
    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByText('We could not determine whether your booking was created.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
    expect(appointmentsReads).toBe(2);
  });

  it('fails safely when appointment reconciliation returns an empty cursor', async () => {
    let appointmentsReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}/slots`) return Promise.resolve(response({ items: [slot], nextCursor: null }));
      if (url.pathname === '/api/appointments' && init?.method === 'POST') return Promise.reject(new TypeError('offline'));
      if (url.pathname === '/api/appointments') { appointmentsReads += 1; return Promise.resolve(response({ items: [], nextCursor: '' })); }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: `/clinicians/${ids.clinician}?date=2030-01-15` });
    await portal.user.click(await screen.findByRole('button', { name: 'Book appointment' }));
    expect(await screen.findByText('We could not determine whether your booking was created.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book appointment' })).toBeDisabled();
    expect(appointmentsReads).toBe(1);
  });

  it('accumulates appointment cursor pages without a duplicate next-page action', async () => {
    let resolveSecond: ((value: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === '/api/appointments' && init?.method === undefined && url.searchParams.get('cursor') === 'next-page') return new Promise<Response>((resolve) => { resolveSecond = resolve; });
      if (url.pathname === '/api/appointments' && init?.method === undefined) return Promise.resolve(response({ items: [appointment], nextCursor: 'next-page' }));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/appointments' });
    expect(await screen.findByText('Upcoming appointment')).toBeInTheDocument();
    await portal.user.click(screen.getByRole('button', { name: 'Load more appointments' }));
    expect(screen.getByRole('button', { name: 'Load more appointments' })).toBeDisabled();
    resolveSecond?.(response({ items: [{ ...appointment, id: '10000000-0000-4000-8000-000000000031', status: 'cancelled', cancelledAt: '2029-12-01T10:00:00.000Z', cancelledBy: ids.patient }], nextCursor: null }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Upcoming appointment')).toBeInTheDocument();
  });

  it('requires an accessible confirmation dialog before cancelling and restores focus', async () => {
    let completeCancellation: ((value: Response) => void) | undefined;
    let currentAppointment: Appointment = appointment;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === '/api/appointments' && !init?.method) return Promise.resolve(response({ items: [currentAppointment], nextCursor: null }));
      if (url.pathname === `/api/appointments/${ids.appointment}/cancel`) return new Promise<Response>((resolve) => { completeCancellation = (value) => { currentAppointment = { ...appointment, status: 'cancelled', cancelledAt: '2029-12-01T10:00:00.000Z', cancelledBy: ids.patient }; resolve(value); }; });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/appointments' });
    const trigger = await screen.findByRole('button', { name: 'Cancel appointment with Dr. Ada Lovelace' });
    await portal.user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Cancel appointment' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Withdraw this slot too' })).not.toBeInTheDocument();
    expect(completeCancellation).toBeUndefined();
    await portal.user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(screen.getByRole('button', { name: 'Confirm cancellation' })).toBeDisabled();
    completeCancellation?.(response({ ...appointment, status: 'cancelled', cancelledAt: '2029-12-01T10:00:00.000Z', cancelledBy: ids.patient }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appointment history' })).toHaveFocus();
    expect(trigger).not.toBeInTheDocument();
  });

  it('restores history focus when cache publication removes the dialog before a delayed refetch settles', async () => {
    let appointmentReads = 0;
    let resolveRefetch: ((value: Response) => void) | undefined;
    const cancelledAppointment: Appointment = { ...appointment, status: 'cancelled', cancelledAt: '2029-12-01T10:00:00.000Z', cancelledBy: ids.patient };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === '/api/appointments' && !init?.method) {
        appointmentReads += 1;
        return appointmentReads === 1 ? Promise.resolve(response({ items: [appointment], nextCursor: null })) : new Promise<Response>((resolve) => { resolveRefetch = resolve; });
      }
      if (url.pathname === `/api/appointments/${ids.appointment}/cancel`) return Promise.resolve(response(cancelledAppointment));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/appointments' });
    await portal.user.click(await screen.findByRole('button', { name: 'Cancel appointment with Dr. Ada Lovelace' }));
    await portal.user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    await waitFor(() => expect(resolveRefetch).toBeDefined());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appointment history' })).toHaveFocus();
    resolveRefetch?.(response({ items: [cancelledAppointment], nextCursor: null }));
  });

  it('moves a cancelled appointment from an earlier accumulated page into history', async () => {
    const laterAppointment: Appointment = { ...appointment, id: '10000000-0000-4000-8000-000000000031', slotId: '10000000-0000-4000-8000-000000000021', clinicianDisplayName: 'Dr. Grace Hopper' };
    let firstPage = appointment;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(me));
      if (url.pathname === '/api/appointments' && !init?.method) return Promise.resolve(url.searchParams.get('cursor') === 'later' ? response({ items: [laterAppointment], nextCursor: null }) : response({ items: [firstPage], nextCursor: 'later' }));
      if (url.pathname === `/api/appointments/${ids.appointment}/cancel`) { firstPage = { ...appointment, status: 'cancelled', cancelledAt: '2029-12-01T10:00:00.000Z', cancelledBy: ids.patient }; return Promise.resolve(response(firstPage)); }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/appointments' });
    const trigger = await screen.findByRole('button', { name: 'Cancel appointment with Dr. Ada Lovelace' });
    await portal.user.click(screen.getByRole('button', { name: 'Load more appointments' }));
    await screen.findByText('Dr. Grace Hopper');
    await portal.user.click(trigger);
    await portal.user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel appointment with Dr. Ada Lovelace' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appointment history' })).toHaveFocus();
    expect(screen.getAllByText('Dr. Ada Lovelace')).toHaveLength(1);
  });
});
