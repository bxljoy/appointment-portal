import { test, expect } from './fixtures.js';
import { acquireTokens, apiContext, futureStart, json, recordRequestId } from './aws-support.js';

type Me = { id: string; role: 'patient' | 'clinician' };
type Slot = { id: string; clinicianId: string; status: 'open' | 'withdrawn'; isBooked: boolean };
type Appointment = { id: string; slotId: string; patientId: string; clinicianId: string; status: 'booked' | 'cancelled' };

test('real patients race, permissions hold, cancellation reopens, and clinician withdrawal closes a slot @aws', async ({ browser, page, playwright }) => {
  test.setTimeout(3 * 60_000);
  await page.goto('/');
  const aliases = ['patient-a', 'patient-b', 'clinician-a', 'clinician-b'] as const;
  const tokens = new Map<string, string>();
  for (const alias of aliases) {
    const context = await browser.newContext({ baseURL: process.env.PORTAL_E2E_AWS_URL, storageState: { cookies: [], origins: [] } });
    try { const login = await context.newPage(); await login.goto('/'); tokens.set(alias, (await acquireTokens(login, alias)).access_token); }
    finally { await context.close(); }
  }
  const clients = Object.fromEntries(await Promise.all(aliases.map(async (alias) => [alias, await apiContext(playwright, tokens.get(alias)!)]))) as Record<typeof aliases[number], Awaited<ReturnType<typeof apiContext>>>;
  try {
    const identities = Object.fromEntries(await Promise.all(aliases.map(async (alias) => [alias, await json<Me>(await clients[alias].get('/api/me'))]))) as Record<typeof aliases[number], Me>;
    const makeSlot = async (clinician: 'clinician-a' | 'clinician-b', offset: number) => {
      const response = await clients[clinician].post('/api/availability', { data: { startAt: futureStart(offset) } });
      recordRequestId(response); expect(response.status()).toBe(201); return json<Slot>(response);
    };

    const raceSlot = await makeSlot('clinician-b', 11);
    const [a, b] = await Promise.all([
      clients['patient-a'].post('/api/appointments', { data: { slotId: raceSlot.id } }),
      clients['patient-b'].post('/api/appointments', { data: { slotId: raceSlot.id } }),
    ]);
    recordRequestId(a); recordRequestId(b);
    expect([a.status(), b.status()].sort()).toEqual([201, 409]);
    const winnerAlias = a.status() === 201 ? 'patient-a' : 'patient-b';
    const loserAlias = winnerAlias === 'patient-a' ? 'patient-b' : 'patient-a';
    const booking = await json<Appointment>(a.status() === 201 ? a : b);
    expect(booking.patientId).toBe(identities[winnerAlias].id);
    const clinicianList = await json<{ items: Appointment[] }>(await clients['clinician-b'].get('/api/appointments?limit=100'));
    expect(clinicianList.items.filter((item) => item.slotId === raceSlot.id && item.status === 'booked')).toHaveLength(1);
    expect((await clients[loserAlias].post(`/api/appointments/${booking.id}/cancel`, { data: { withdrawSlot: false } })).status()).toBe(404);
    const raceCleanup = await clients['clinician-b'].post(`/api/appointments/${booking.id}/cancel`, { data: { withdrawSlot: true } });
    recordRequestId(raceCleanup); expect(raceCleanup.status()).toBe(200);

    const reopened = await makeSlot('clinician-a', 23);
    const forged = await clients['patient-a'].post('/api/appointments', { data: { slotId: reopened.id, patientId: identities['patient-b'].id } });
    recordRequestId(forged); expect(forged.status()).toBe(400);
    const firstBookingResponse = await clients['patient-a'].post('/api/appointments', { data: { slotId: reopened.id } });
    const firstBooking = await json<Appointment>(firstBookingResponse); recordRequestId(firstBookingResponse); expect(firstBookingResponse.status()).toBe(201);
    const cancelled = await clients['patient-a'].post(`/api/appointments/${firstBooking.id}/cancel`, { data: { withdrawSlot: false } });
    recordRequestId(cancelled); expect(cancelled.status()).toBe(200);
    const secondBookingResponse = await clients['patient-b'].post('/api/appointments', { data: { slotId: reopened.id } });
    const secondBooking = await json<Appointment>(secondBookingResponse); recordRequestId(secondBookingResponse); expect(secondBookingResponse.status()).toBe(201);
    const withdrawn = await clients['clinician-a'].post(`/api/appointments/${secondBooking.id}/cancel`, { data: { withdrawSlot: true } });
    recordRequestId(withdrawn); expect(withdrawn.status()).toBe(200);
    const ownSlots = await json<{ items: Slot[] }>(await clients['clinician-a'].get('/api/availability?limit=100'));
    expect(ownSlots.items).toContainEqual(expect.objectContaining({ id: reopened.id, status: 'withdrawn', isBooked: false }));
  } finally { await Promise.all(Object.values(clients).map((client) => client.dispose())); }
});

test('deployed authorization conceals foreign resources and rejects wrong-role and forged identity operations @aws', async ({ browser, page, playwright }) => {
  test.setTimeout(3 * 60_000);
  await page.goto('/');
  const aliases = ['patient-a', 'patient-b', 'clinician-a', 'clinician-b'] as const;
  const tokens = new Map<string, string>();
  for (const alias of aliases) {
    const context = await browser.newContext({ baseURL: process.env.PORTAL_E2E_AWS_URL, storageState: { cookies: [], origins: [] } });
    try { const login = await context.newPage(); await login.goto('/'); tokens.set(alias, (await acquireTokens(login, alias)).access_token); }
    finally { await context.close(); }
  }
  const clients = Object.fromEntries(await Promise.all(aliases.map(async (alias) => [alias, await apiContext(playwright, tokens.get(alias)!)]))) as Record<typeof aliases[number], Awaited<ReturnType<typeof apiContext>>>;
  const checked = async (response: Awaited<ReturnType<typeof clients['patient-a']['get']>>, status: number) => { recordRequestId(response); expect(response.status()).toBe(status); };
  try {
    const identities = Object.fromEntries(await Promise.all(aliases.map(async (alias) => {
      const response = await clients[alias].get('/api/me'); await checked(response, 200); return [alias, await json<Me>(response)];
    }))) as Record<typeof aliases[number], Me>;
    await checked(await clients['patient-a'].post('/api/availability', { data: { startAt: futureStart(101) } }), 403);
    await checked(await clients['patient-a'].post('/api/availability', { data: { startAt: futureStart(102), clinicianId: identities['clinician-a'].id, role: 'clinician' } }), 400);
    const slotResponse = await clients['clinician-a'].post('/api/availability', { data: { startAt: futureStart(103) } });
    await checked(slotResponse, 201); const slot = await json<Slot>(slotResponse);
    await checked(await clients['patient-a'].post(`/api/availability/${slot.id}/withdraw`), 403);
    await checked(await clients['clinician-b'].post(`/api/availability/${slot.id}/withdraw`), 404);
    await checked(await clients['clinician-b'].post('/api/appointments', { data: { slotId: slot.id } }), 403);
    const forged = await clients['patient-a'].post('/api/appointments', { data: { slotId: slot.id, patientId: identities['patient-b'].id, role: 'patient' } });
    await checked(forged, 400);
    const bookingResponse = await clients['patient-a'].post('/api/appointments', { data: { slotId: slot.id } });
    await checked(bookingResponse, 201); const booking = await json<Appointment>(bookingResponse);
    await checked(await clients['clinician-b'].post(`/api/appointments/${booking.id}/cancel`, { data: { withdrawSlot: true } }), 404);
    const ownerAppointmentsResponse = await clients['patient-a'].get('/api/appointments?limit=100'); await checked(ownerAppointmentsResponse, 200);
    const ownerAppointments = await json<{ items: Appointment[] }>(ownerAppointmentsResponse);
    expect(ownerAppointments.items).toContainEqual(expect.objectContaining({ id: booking.id, status: 'booked' }));
    const ownerSlotsResponse = await clients['clinician-a'].get('/api/availability?limit=100'); await checked(ownerSlotsResponse, 200);
    const ownerSlots = await json<{ items: Slot[] }>(ownerSlotsResponse);
    expect(ownerSlots.items).toContainEqual(expect.objectContaining({ id: slot.id, status: 'open', isBooked: true }));
    await checked(await clients['clinician-a'].post(`/api/appointments/${booking.id}/cancel`, { data: { withdrawSlot: true } }), 200);
  } finally { await Promise.all(Object.values(clients).map((client) => client.dispose())); }
});
