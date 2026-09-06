import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Appointment, Slot } from '@portal/contracts';

import { AppRoutes } from '../../app/router';
import { renderPortalPage } from '../../test/render';

const ids = {
  clinician: '10000000-0000-4000-8000-000000000010',
  patient: '10000000-0000-4000-8000-000000000001',
  slot: '10000000-0000-4000-8000-000000000020',
  appointment: '10000000-0000-4000-8000-000000000030',
};
const clinician = { id: ids.clinician, displayName: 'Dr. Ada Lovelace', role: 'clinician' };
const clinicianProfile = { id: ids.clinician, displayName: 'Dr. Ada Lovelace', biography: 'Supports practical care planning.', specialty: 'Primary care', timezone: 'Europe/Stockholm' };
const patient = { id: ids.patient, displayName: 'Pat Lee', role: 'patient' };
const slot: Slot = { id: ids.slot, clinicianId: ids.clinician, startAt: '2030-01-15T09:00:00Z', endAt: '2030-01-15T09:30:00Z', status: 'open', isBooked: false };
const appointment: Appointment = { id: ids.appointment, slotId: ids.slot, clinicianId: ids.clinician, patientId: ids.patient, patientDisplayName: 'Pat Lee', clinicianDisplayName: 'Dr. Ada Lovelace', startAt: slot.startAt, endAt: slot.endAt, status: 'booked', cancelledAt: null, cancelledBy: null };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const slotsInRequestedWindow = (url: URL, slots: Slot[]) => {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  const fromInstant = Temporal.Instant.from(from!);
  const toInstant = Temporal.Instant.from(to!);
  expect(Temporal.Instant.compare(fromInstant, toInstant)).toBeLessThan(0);
  return slots.filter((slot) => Temporal.Instant.compare(Temporal.Instant.from(slot.startAt), fromInstant) >= 0 && Temporal.Instant.compare(Temporal.Instant.from(slot.startAt), toInstant) < 0);
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('clinician scheduling journeys', () => {
  it('publishes a timezone-labelled slot and previews its 30-minute end', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/availability' && !init?.method) return Promise.resolve(response({ items: slotsInRequestedWindow(url, [slot]), nextCursor: null }));
      if (url.pathname === '/api/availability' && init?.method === 'POST') return Promise.resolve(response(slot, 201));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/availability', sub: 'clinician-sub' });

    expect(await screen.findByRole('heading', { name: 'Your availability' })).toBeInTheDocument();
    expect(await screen.findAllByText(/timezone: Europe\/Stockholm/i)).not.toHaveLength(0);
    await portal.user.type(screen.getByLabelText('Start time'), '2030-01-15T10:00');
    expect(screen.getByText(/Ends at .*10:30/)).toBeInTheDocument();
    await portal.user.click(screen.getByRole('button', { name: 'Publish slot' }));
    expect(await screen.findByText('Slot published')).toBeInTheDocument();
  });

  it('shows patient names and offers clinician cancellation with an opt-in withdrawal', async () => {
    let cancelBody: unknown;
    let currentAppointment = appointment;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/appointments' && !init?.method) return Promise.resolve(response({ items: [currentAppointment], nextCursor: null }));
      if (url.pathname === `/api/appointments/${ids.appointment}/cancel`) {
        cancelBody = JSON.parse(String(init?.body));
        currentAppointment = { ...appointment, status: 'cancelled', cancelledAt: '2029-01-01T00:00:00Z', cancelledBy: ids.clinician };
        return Promise.resolve(response(currentAppointment));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/appointments', sub: 'clinician-sub' });

    expect(await screen.findByText('Pat Lee')).toBeInTheDocument();
    await portal.user.click(screen.getByRole('button', { name: 'Cancel appointment with Pat Lee' }));
    const checkbox = screen.getByRole('checkbox', { name: 'Withdraw this slot too' });
    expect(checkbox).not.toBeChecked();
    await portal.user.click(checkbox);
    expect(screen.getByText(/it will no longer be available to book/i)).toBeInTheDocument();
    expect(screen.queryByText(/become available to book again/i)).not.toBeInTheDocument();
    await portal.user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await screen.findByText('Cancelled');
    expect(cancelBody).toEqual({ withdrawSlot: true });
  });

  it('offers withdrawal only for a future open and unbooked agenda entry', async () => {
    vi.spyOn(Temporal.Now, 'instant').mockReturnValue(Temporal.Instant.from('2030-01-15T12:00:00Z'));
    const future = { ...slot, startAt: '2030-01-16T09:00:00Z', endAt: '2030-01-16T09:30:00Z' };
    const booked = { ...future, id: '10000000-0000-4000-8000-000000000021', isBooked: true };
    const withdrawn = { ...future, id: '10000000-0000-4000-8000-000000000022', status: 'withdrawn' as const };
    const past = { ...future, id: '10000000-0000-4000-8000-000000000023', startAt: '2030-01-15T09:00:00Z', endAt: '2030-01-15T09:30:00Z' };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/availability' && !init?.method) return Promise.resolve(response({ items: slotsInRequestedWindow(url, [future, booked, withdrawn, past]), nextCursor: null }));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/availability', sub: 'clinician-sub' });
    fireEvent.change(await screen.findByLabelText('Availability week starting'), { target: { value: '2030-01-14' } });

    expect(await screen.findAllByText('Open — available to patients')).toHaveLength(2);
    expect(screen.getByText('Open — booked')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Withdraw slot' })).toHaveLength(1);
  });

  it('requests an explicit profile-timezone week and keeps far-future availability manageable across pages', async () => {
    const first = { ...slot, id: '10000000-0000-4000-8000-000000000024', startAt: '2030-02-09T09:00:00Z', endAt: '2030-02-09T09:30:00Z' };
    const second = { ...slot, id: '10000000-0000-4000-8000-000000000025', startAt: '2030-02-10T09:00:00Z', endAt: '2030-02-10T09:30:00Z' };
    const requested: URL[] = [];
    let resolveNextPage: ((value: Response) => void) | undefined;
    let loadingNextPage = true;
    let firstPage = first;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/availability' && !init?.method) {
        requested.push(url);
        if (url.searchParams.get('from') === '2030-02-07T23:00:00Z' && url.searchParams.get('cursor') === 'next-page' && loadingNextPage) {
          return new Promise<Response>((resolve) => { resolveNextPage = resolve; });
        }
        if (url.searchParams.get('from') === '2030-02-07T23:00:00Z' && url.searchParams.get('cursor') === 'next-page') return Promise.resolve(response({ items: slotsInRequestedWindow(url, [second]), nextCursor: null }));
        if (url.searchParams.get('from') === '2030-02-07T23:00:00Z') return Promise.resolve(response({ items: slotsInRequestedWindow(url, [firstPage]), nextCursor: 'next-page' }));
        return Promise.resolve(response({ items: slotsInRequestedWindow(url, []), nextCursor: null }));
      }
      if (url.pathname === `/api/availability/${first.id}/withdraw`) {
        firstPage = { ...first, status: 'withdrawn' };
        return Promise.resolve(response(firstPage));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/availability', sub: 'clinician-sub' });

    const week = await screen.findByLabelText('Availability week starting');
    fireEvent.change(week, { target: { value: '2030-02-08' } });
    expect(await screen.findByText(/Sat, 9 Feb 2030/)).toBeInTheDocument();
    await waitFor(() => expect(requested.some((url) => url.searchParams.get('from') === '2030-02-07T23:00:00Z' && url.searchParams.get('to') === '2030-02-14T23:00:00Z')).toBe(true));
    const loadMore = screen.getByRole('button', { name: 'Load more availability' });
    await portal.user.click(loadMore);
    expect(loadMore).toBeDisabled();
    expect(screen.getByText(/Sat, 9 Feb 2030/)).toBeInTheDocument();
    loadingNextPage = false;
    resolveNextPage?.(response({ items: [second], nextCursor: null }));
    expect(await screen.findByText(/Sun, 10 Feb 2030/)).toBeInTheDocument();
    await portal.user.click(screen.getAllByRole('button', { name: 'Withdraw slot' })[0]!);
    expect(await screen.findByText('Withdrawn')).toBeInTheDocument();
  });

  it('accumulates clinician appointments while loading the next page', async () => {
    const anotherAppointment = { ...appointment, id: '10000000-0000-4000-8000-000000000031', slotId: '10000000-0000-4000-8000-000000000026', patientDisplayName: 'Bea Kim', startAt: '2030-01-16T09:00:00Z', endAt: '2030-01-16T09:30:00Z' };
    let firstPage = appointment;
    let resolveNextPage: ((value: Response) => void) | undefined;
    let loadingNextPage = true;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/appointments' && !init?.method) {
        if (url.searchParams.get('cursor') === 'next-page' && loadingNextPage) return new Promise<Response>((resolve) => { resolveNextPage = resolve; });
        if (url.searchParams.get('cursor') === 'next-page') return Promise.resolve(response({ items: [anotherAppointment], nextCursor: null }));
        return Promise.resolve(response({ items: [firstPage], nextCursor: 'next-page' }));
      }
      if (url.pathname === `/api/appointments/${ids.appointment}/cancel`) {
        firstPage = { ...appointment, status: 'cancelled', cancelledAt: '2029-01-01T00:00:00Z', cancelledBy: ids.clinician };
        return Promise.resolve(response(firstPage));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/appointments', sub: 'clinician-sub' });

    expect(await screen.findByText('Pat Lee')).toBeInTheDocument();
    const loadMore = screen.getByRole('button', { name: 'Load more appointments' });
    await portal.user.click(loadMore);
    expect(loadMore).toBeDisabled();
    expect(screen.getByText('Pat Lee')).toBeInTheDocument();
    loadingNextPage = false;
    resolveNextPage?.(response({ items: [anotherAppointment], nextCursor: null }));
    expect(await screen.findByText('Bea Kim')).toBeInTheDocument();
    expect(screen.getByText('Pat Lee')).toBeInTheDocument();
    await portal.user.click(screen.getByRole('button', { name: 'Cancel appointment with Pat Lee' }));
    await portal.user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Bea Kim')).toBeInTheDocument();
  });

  it('explains an overlapping slot without losing the entered time or reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/availability' && !init?.method) return Promise.resolve(response({ items: slotsInRequestedWindow(url, []), nextCursor: null }));
      if (url.pathname === '/api/availability' && init?.method === 'POST') return Promise.resolve(response({ error: { code: 'SLOT_OVERLAP', message: 'This slot overlaps an existing availability entry.', requestId: 'request-overlap' } }, 409));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const portal = renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/availability', sub: 'clinician-sub' });

    const start = await screen.findByLabelText('Start time');
    await portal.user.type(start, '2030-01-15T10:00');
    await portal.user.click(screen.getByRole('button', { name: 'Publish slot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This slot overlaps an existing availability entry.');
    expect(start).toHaveValue('2030-01-15T10:00');
    expect(screen.queryByText('Slot published')).not.toBeInTheDocument();
  });

  it('rejects patient access to clinician routes before clinician data requests', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(patient));
      throw new Error(`Patient route guard should have prevented ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/availability' });

    expect(await screen.findByRole('heading', { name: 'This page is for clinicians' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
