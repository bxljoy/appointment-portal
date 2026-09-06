import { test, expect, signIn, openSlots } from './fixtures.js';

test('clinician publishes a 30-minute slot and withdraws it @local', async ({ page, scenario }) => {
  await page.goto('/'); await signIn(page, 'clinician-a');
  await page.getByRole('link', { name: 'Availability', exact: true }).click();
  await page.getByLabel('Availability week starting').fill(scenario.day);
  await page.getByLabel('Start time', { exact: true }).fill(`${scenario.day}T16:00`);
  await expect(page.getByRole('status').filter({ hasText: 'Ends at' })).toContainText('16:30');
  await page.getByRole('button', { name: 'Publish slot', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Slot published' })).toBeVisible();
  const slot = page.getByRole('listitem').filter({ hasText: '16:00' });
  await expect(slot).toContainText('Open — available to patients');
  await slot.getByRole('button', { name: 'Withdraw slot', exact: true }).click();
  await expect(slot).toContainText('Withdrawn');
  await expect(slot.getByRole('button')).toHaveCount(0);
});

test('clinician cancels and withdraws an occupied slot atomically @local', async ({ page, scenario }) => {
  await page.goto('/'); await signIn(page, 'patient-a'); await openSlots(page, scenario.day);
  const bookedId = await page.getByRole('radio').first().inputValue();
  await page.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Appointment confirmed');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, 'clinician-a');
  await page.getByRole('link', { name: 'My appointments', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel appointment with Alice Patient' }).click();
  await page.getByRole('checkbox', { name: 'Withdraw this slot too' }).check();
  await expect(page.getByRole('dialog')).toContainText('It will no longer be available to book.');
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByRole('heading', { name: 'Appointment history' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Appointment history' })).toContainText('Cancelled');
  const result = await scenario.pool.query('SELECT s.status AS slot, a.status AS appointment FROM availability_slots s JOIN appointments a ON a.slot_id = s.id WHERE s.id = $1', [bookedId]);
  expect(result.rows).toEqual([{ slot: 'withdrawn', appointment: 'cancelled' }]);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await signIn(page, 'patient-b');
  await openSlots(page, scenario.day);
  expect(await page.getByRole('radio').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).not.toContain(bookedId);
});
