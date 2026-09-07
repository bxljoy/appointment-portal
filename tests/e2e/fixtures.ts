import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { z } from 'zod';
import { accounts, names, startLocalPortal, type Account } from './local-auth.setup.js';
import { assertAwsArtifactPrivacy } from './aws-artifact-privacy.js';
import { readPrivateFile } from '../../scripts/private-file.js';

type Portal = Awaited<ReturnType<typeof startLocalPortal>>;
const isAwsProject = (name: string) => name === 'aws' || name === 'aws-mobile';
export const test = base.extend<{ scenario: Portal; artifactPrivacy: void }, { portal: Portal | undefined }>({
  artifactPrivacy: [async ({ trace, video, screenshot, storageState, contextOptions }, use, info) => {
    if (isAwsProject(info.project.name)) assertAwsArtifactPrivacy(info.config.reporter, { trace, video, screenshot, storageState, contextOptions });
    await use();
  }, { auto: true }],
  portal: [async ({ browserName }, use, info) => {
    if (browserName !== 'chromium') throw new Error('Portal browser fixtures require Chromium.');
    if (isAwsProject(info.project.name)) { await use(undefined); return; }
    const portal = await startLocalPortal();
    try { await use(portal); } finally { await portal.close(); }
  }, { scope: 'worker' }],
  baseURL: async ({ portal }, use, info) => { await use(portal?.baseUrl ?? info.project.use.baseURL); },
  scenario: async ({ portal }, use) => {
    if (!portal) throw new Error('Local database fixtures cannot run against AWS.');
    await portal.reset(); await use(portal);
  },
});
export { expect, accounts, names };

const credentialSchema = z.object({ email: z.email(), password: z.string().min(12), role: z.enum(['patient', 'clinician']), sub: z.uuid() });
export async function awsCredential(account: Account) {
  const path = process.env[`PORTAL_E2E_${account.replace('-', '_').toUpperCase()}_FILE`];
  if (!path) throw new Error('A runtime account file is required.');
  const directory = resolve('.runtime');
  const directoryInfo = await lstat(directory);
  const target = resolve(path);
  const child = relative(directory, target);
  if (!child || child.startsWith('..') || isAbsolute(child) || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    directoryInfo.uid !== process.getuid?.() || (directoryInfo.mode & 0o777) !== 0o700) throw new Error('Unsafe runtime credential directory.');
  const parsed = credentialSchema.safeParse(JSON.parse(await readPrivateFile(target, 16_384)));
  if (!parsed.success || parsed.data.role !== (account.startsWith('patient') ? 'patient' : 'clinician')) throw new Error('Invalid runtime account file.');
  return parsed.data;
}

export async function signIn(page: Page, account: Account) {
  if (!(accounts as readonly string[]).includes(account)) throw new Error('Unknown E2E account.');
  if (!isAwsProject(test.info().project.name)) {
    await page.getByLabel('Development identity', { exact: true }).selectOption(account);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } else {
    try {
      if (process.env.PORTAL_E2E_AWS !== '1' || new URL(page.url()).protocol !== 'https:') throw new Error();
      const config = await (await page.request.get(new URL('/config.json', page.url()).href)).json() as { mode: string; cognitoDomain: string };
      if (config.mode !== 'cognito' || !/^https:\/\/[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(config.cognitoDomain)) throw new Error();
      const credentials = await awsCredential(account);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL((url) => url.origin === config.cognitoDomain);
      await page.getByLabel('Email', { exact: true }).fill(credentials.email);
      await page.getByLabel('Password', { exact: true }).fill(credentials.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    } catch { throw new Error('Managed login failed. Check the controlled account and Cognito configuration locally; no credential diagnostics were retained.'); }
  }
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}

export async function openSlots(page: Page, day: string, clinician: Account = 'clinician-a') {
  await page.getByRole('link', { name: 'Find a clinician', exact: true }).click();
  await page.getByRole('link', { name: names[clinician], exact: true }).click();
  await page.getByLabel('Date', { exact: true }).fill(day);
  await expect(page.getByRole('radio').first()).toBeVisible();
}

export async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 40; index++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}
