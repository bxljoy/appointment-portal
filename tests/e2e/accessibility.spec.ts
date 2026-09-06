import { AxeBuilder } from '@axe-core/playwright';
import { test, expect, signIn, openSlots, tabTo } from './fixtures.js';
import type { Page } from '@playwright/test';

async function audit(page: Page, screen: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? '')).map((violation) => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controlContrast = await page.locator('input[type="date"], input[type="datetime-local"], select').evaluateAll((controls) => {
    const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
      const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    return controls.filter((control) => control.getClientRects().length && !control.closest('[aria-hidden="true"]')).map((control) => {
      const style = getComputedStyle(control);
      const border = luminance(style.borderColor), background = luminance(style.backgroundColor);
      return { id: control.id, ratio: (Math.max(border, background) + 0.05) / (Math.min(border, background) + 0.05) };
    });
  });
  expect(controlContrast.filter((control) => control.ratio < 3)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath(`${screen}.png`), fullPage: true });
}

test('keyboard booking and dialog closing, trapping, confirming and focus return @local', async ({ page, scenario }) => {
  await page.goto('/'); await signIn(page, 'patient-a'); await openSlots(page, scenario.day);
  const radios = page.getByRole('radio');
  await tabTo(page, radios.first());
  await page.keyboard.press('ArrowDown');
  await expect(radios.nth(1)).toBeChecked(); await expect(radios.nth(1)).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Book appointment', exact: true })); await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Appointment confirmed');
  await tabTo(page, page.getByRole('link', { name: 'My appointments', exact: true })); await page.keyboard.press('Enter');
  const trigger = page.getByRole('button', { name: 'Cancel appointment with Casey Clinician' });
  await tabTo(page, trigger); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Cancel appointment', exact: true });
  await expect(dialog).toBeVisible();
  await audit(page, 'cancel-dialog');
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter'); await tabTo(page, page.getByRole('button', { name: 'Keep appointment' })); await page.keyboard.press('Enter');
  await expect(trigger).toBeFocused(); await page.keyboard.press('Enter');
  await tabTo(page, page.getByRole('button', { name: 'Confirm cancellation' })); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Appointment history' })).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('You have no upcoming appointments.');
  await audit(page, 'patient-history');
});

test('invalid clinician form focuses its field and announces the associated error @local', async ({ page, scenario }) => {
  await page.goto('/'); await signIn(page, 'clinician-a');
  await page.getByRole('link', { name: 'Availability', exact: true }).click();
  await page.getByLabel('Availability week starting').fill(scenario.day);
  await tabTo(page, page.getByRole('button', { name: 'Publish slot', exact: true })); await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Choose a local time.');
  const field = page.getByLabel('Start time', { exact: true });
  await expect(field).toBeFocused(); await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/Choose a local time/);
  await audit(page, 'invalid-clinician-form');
});

test('axe and width checks cover sign-in, directory, booking, both clinician workspaces @local', async ({ page, scenario }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible(); await audit(page, 'sign-in');
  await signIn(page, 'patient-a'); await expect(page.getByRole('link', { name: 'Casey Clinician' })).toBeVisible(); await audit(page, 'directory');
  await openSlots(page, scenario.day); await audit(page, 'booking');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await signIn(page, 'clinician-a');
  await page.getByRole('link', { name: 'Availability', exact: true }).click();
  await expect(page.getByLabel('Start time', { exact: true })).toBeVisible(); await page.getByLabel('Availability week starting').fill(scenario.day); await audit(page, 'clinician-availability');
  await page.getByRole('link', { name: 'My appointments', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Appointment history' })).toBeVisible(); await audit(page, 'clinician-appointments');
});

test('a real booking conflict announces an error and refreshes keyboard choices @local', async ({ page, scenario }) => {
  await page.goto('/'); await signIn(page, 'patient-a'); await openSlots(page, scenario.day);
  const slotId = await page.getByRole('radio').first().inputValue();
  await tabTo(page, page.getByRole('radio').first()); await page.keyboard.press('Space');
  const competitor = await page.request.post('/api/appointments', { headers: { 'X-Local-Actor': 'patient-b' }, data: { slotId } });
  expect(competitor.status()).toBe(201);
  await tabTo(page, page.getByRole('button', { name: 'Book appointment', exact: true })); await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('This slot was just booked. Please choose another.');
  await expect(page.getByRole('radio')).toHaveCount(1);
  await tabTo(page, page.getByRole('radio')); await expect(page.getByRole('radio')).toBeFocused();
  await audit(page, 'booking-conflict');
});
