import { screen } from '@testing-library/react';
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

afterEach(() => vi.unstubAllGlobals());

describe('clinician scheduling journeys', () => {
  it('publishes a timezone-labelled slot and previews its 30-minute end', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/availability' && !init?.method) return Promise.resolve(response({ items: [slot], nextCursor: null }));
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
    await portal.user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await screen.findByText('Cancelled');
    expect(cancelBody).toEqual({ withdrawSlot: true });
  });

  it('offers withdrawal only for a future open and unbooked agenda entry', async () => {
    const booked = { ...slot, id: '10000000-0000-4000-8000-000000000021', isBooked: true };
    const withdrawn = { ...slot, id: '10000000-0000-4000-8000-000000000022', status: 'withdrawn' as const };
    const past = { ...slot, id: '10000000-0000-4000-8000-000000000023', startAt: '2020-01-15T09:00:00Z', endAt: '2020-01-15T09:30:00Z' };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'https://portal.test');
      if (url.pathname === '/api/me') return Promise.resolve(response(clinician));
      if (url.pathname === `/api/clinicians/${ids.clinician}`) return Promise.resolve(response(clinicianProfile));
      if (url.pathname === '/api/availability' && !init?.method) return Promise.resolve(response({ items: [slot, booked, withdrawn, past], nextCursor: null }));
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    renderPortalPage(<AppRoutes />, { initialEntry: '/clinician/availability', sub: 'clinician-sub' });

    expect(await screen.findAllByText('Open — available to patients')).toHaveLength(2);
    expect(screen.getByText('Open — booked')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Withdraw slot' })).toHaveLength(1);
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
