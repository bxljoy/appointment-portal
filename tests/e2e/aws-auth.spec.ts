import { test, expect } from './fixtures.js';
import { jwtClaims, signInThroughApplication } from './aws-support.js';

test('managed login uses authorization code PKCE, access tokens, logout, and safe return navigation @aws', async ({ page }) => {
  await page.goto('/appointments');
  let observedAuthorization = '';
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/me') observedAuthorization = request.headers().authorization ?? '';
  });
  const first = await signInThroughApplication(page, 'patient-a');
  expect(first.authorizationUrl.searchParams.get('response_type')).toBe('code');
  expect(first.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(first.authorizationUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(new Set(first.authorizationUrl.searchParams.get('scope')?.split(' '))).toEqual(new Set(['openid', 'profile', 'portal/access']));
  expect(jwtClaims(first.tokens.access_token)).toMatchObject({ token_use: 'access' });
  expect(jwtClaims(first.tokens.id_token)).toMatchObject({ token_use: 'id' });
  await expect.poll(() => observedAuthorization.length).toBeGreaterThan(100);
  expect(observedAuthorization.startsWith('Bearer ')).toBe(true);
  expect(jwtClaims(observedAuthorization.slice(7))).toMatchObject({ token_use: 'access' });
  await expect(page).toHaveURL(/\/appointments$/);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await signInThroughApplication(page, 'patient-a');
  await expect(page).toHaveURL(/\/appointments$/);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/signed-out$/);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('nested SPA refresh resolves to the app while a missing asset stays missing @aws', async ({ page }) => {
  const nested = await page.goto('/appointments');
  expect(nested?.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  const missing = await page.request.get(`/assets/missing-${Date.now()}.js`);
  expect([403, 404]).toContain(missing.status());
  expect(missing.headers()['content-type'] ?? '').not.toContain('text/html');
});
