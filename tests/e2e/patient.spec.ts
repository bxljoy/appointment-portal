import { test, expect, signIn, openSlots, accounts } from './fixtures.js';

test('patient browses, books, cancels, sees history and rebooks @local', async ({ page, scenario }) => {
  await page.goto('/'); await signIn(page, 'patient-a');
  await openSlots(page, scenario.day);
  const chosen = await page.getByRole('radio').first().inputValue();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Appointment confirmed');
  await page.getByRole('link', { name: 'My appointments', exact: true }).click();
  await expect(page.getByText('Upcoming appointment', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel appointment with Casey Clinician' }).click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Appointment history' }).getByText('Cancelled', { exact: true })).toBeVisible();
  await openSlots(page, scenario.day);
  await expect(page.getByRole('radio').first()).toHaveValue(chosen);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Appointment confirmed');
  const rows = await scenario.pool.query('SELECT status FROM appointments WHERE slot_id = $1 ORDER BY created_at', [chosen]);
  expect(rows.rows).toEqual([{ status: 'cancelled' }, { status: 'booked' }]);
});

test('parallel patients compete for a dedicated slot through real HTTP @local', async ({ playwright, scenario }) => {
  const clinician = await scenario.pool.query<{ id: string }>("SELECT id FROM users WHERE cognito_sub = 'clinician-b'");
  const slot = await scenario.pool.query<{ id: string }>("INSERT INTO availability_slots(clinician_id, start_at, end_at) VALUES ($1, $2::timestamptz, $2::timestamptz + interval '30 minutes') RETURNING id", [clinician.rows[0]!.id, `${scenario.day}T15:00:00Z`]);
  const slotId = slot.rows[0]!.id;
  const clients = await Promise.all(['patient-a', 'patient-b'].map((actor) => playwright.request.newContext({ baseURL: scenario.apiUrl, extraHTTPHeaders: { 'X-Local-Actor': actor } })));
  try {
    const responses = await Promise.all(clients.map((client) => client.post('/api/appointments', { data: { slotId } })));
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409]);
    const appointments = await Promise.all(clients.map(async (client) => (await (await client.get('/api/appointments')).json()).items as { slotId: string; status: string }[]));
    expect(appointments.flat().filter((row) => row.slotId === slotId && row.status === 'booked')).toHaveLength(1);
    expect((await scenario.pool.query("SELECT count(*)::int AS count FROM appointments WHERE slot_id = $1 AND status = 'booked'", [slotId])).rows).toEqual([{ count: 1 }]);
  } finally { await Promise.all(clients.map((client) => client.dispose())); }
});

for (const account of accounts) {
  test(`managed login and logout for ${account} @aws`, async ({ page }) => {
    await page.goto('/'); await signIn(page, account);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Availability', exact: true })).toHaveCount(account.startsWith('clinician') ? 1 : 0);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });
}
