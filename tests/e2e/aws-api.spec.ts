import { test, expect } from './fixtures.js';
import { acquireTokens, apiContext, awsRuntimeConfig, jwtClaims, json, recordRequestId } from './aws-support.js';

test('CloudFront and the direct API require a scoped access token and do not cache private responses @aws', async ({ page, playwright }) => {
  await page.goto('/');
  const full = await acquireTokens(page, 'patient-a');
  expect(jwtClaims(full.access_token)).toMatchObject({ token_use: 'access' });
  expect(String(jwtClaims(full.access_token).scope).split(' ')).toContain('portal/access');
  const cloudfront = await apiContext(playwright, full.access_token);
  const direct = await apiContext(playwright, full.access_token, true);
  try {
    const first = await cloudfront.get('/api/me'); recordRequestId(first); expect(first.status()).toBe(200);
    const second = await cloudfront.get('/api/me'); recordRequestId(second); expect(second.status()).toBe(200);
    for (const response of [first, second]) expect(response.headers()['x-cache'] ?? '').not.toMatch(/^Hit from cloudfront$/i);
    const directValid = await direct.get('/api/me'); recordRequestId(directValid); expect(directValid.status()).toBe(200);

    const unauthenticated = await playwright.request.newContext({ baseURL: process.env.PORTAL_E2E_AWS_URL });
    const directUnauthenticated = await playwright.request.newContext({ baseURL: process.env.PORTAL_E2E_AWS_API_URL });
    try {
      expect((await unauthenticated.get('/api/me')).status()).toBe(401);
      expect((await directUnauthenticated.get('/api/me')).status()).toBe(401);
      expect((await unauthenticated.get('/api/me', { headers: { Authorization: 'Bearer malformed.jwt.value' } })).status()).toBe(401);
      expect((await unauthenticated.get('/api/me', { headers: { Authorization: `Bearer ${full.id_token}` } })).status()).toBe(401);
    } finally { await unauthenticated.dispose(); await directUnauthenticated.dispose(); }
  } finally { await cloudfront.dispose(); await direct.dispose(); }
});

test('a valid Cognito access token without portal scope is rejected @aws', async ({ page, playwright }) => {
  await page.goto('/');
  const tokens = await acquireTokens(page, 'patient-a', 'openid profile');
  expect(jwtClaims(tokens.access_token)).toMatchObject({ token_use: 'access' });
  expect(String(jwtClaims(tokens.access_token).scope).split(' ')).not.toContain('portal/access');
  const context = await apiContext(playwright, tokens.access_token);
  try { expect((await context.get('/api/me')).status()).toBe(403); } finally { await context.dispose(); }
});

test('the S3 origin is private and CloudFront returns caller-specific identity @aws', async ({ page, playwright }) => {
  await page.goto('/');
  const [patient, clinician] = await Promise.all([
    acquireTokens(page, 'patient-a'),
    (async () => { const context = await page.context().browser()!.newContext({ baseURL: process.env.PORTAL_E2E_AWS_URL, storageState: { cookies: [], origins: [] } });
      try { const other = await context.newPage(); await other.goto('/'); return await acquireTokens(other, 'clinician-a'); } finally { await context.close(); } })(),
  ]);
  const patientApi = await apiContext(playwright, patient.access_token);
  const clinicianApi = await apiContext(playwright, clinician.access_token);
  try {
    const patientMe = await json<{ id: string; role: string }>(await patientApi.get('/api/me'));
    const clinicianMe = await json<{ id: string; role: string }>(await clinicianApi.get('/api/me'));
    expect(patientMe.role).toBe('patient'); expect(clinicianMe.role).toBe('clinician'); expect(patientMe.id).not.toBe(clinicianMe.id);
  } finally { await patientApi.dispose(); await clinicianApi.dispose(); }
  const region = process.env.PORTAL_E2E_AWS_REGION;
  const bucket = process.env.PORTAL_E2E_AWS_BUCKET;
  if (!region || !bucket || !/^[a-z0-9.-]+$/.test(bucket)) throw new Error('Deployed S3 coordinates are required.');
  const anonymous = await playwright.request.newContext();
  try {
    const directObject = await anonymous.get(`https://${bucket}.s3.${region}.amazonaws.com/index.html`);
    expect([403, 404]).toContain(directObject.status());
  } finally { await anonymous.dispose(); }
  const config = await awsRuntimeConfig(page); expect(config.mode).toBe('cognito');
});

test('the separately controlled burst is throttled without server errors @aws', async ({ page, playwright }) => {
  await page.goto('/');
  const tokens = await acquireTokens(page, 'patient-b');
  const context = await apiContext(playwright, tokens.access_token);
  try {
    const responses = await Promise.all(Array.from({ length: 30 }, () => context.get('/api/me')));
    const statuses = responses.map((response) => response.status());
    expect(statuses).toContain(429);
    expect(statuses.every((status) => status === 200 || status === 429)).toBe(true);
  } finally { await context.dispose(); }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
});

test('an issued access token actually expires at the deployed authorizer @aws', async ({ page, playwright }) => {
  test.setTimeout(7 * 60_000);
  await page.goto('/');
  const tokens = await acquireTokens(page, 'patient-b');
  const expiresAt = Number(jwtClaims(tokens.access_token).exp) * 1_000;
  const waitMs = expiresAt - Date.now() + 2_000;
  expect(waitMs).toBeGreaterThan(0); expect(waitMs).toBeLessThanOrEqual(6 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const context = await apiContext(playwright, tokens.access_token);
  try { expect((await context.get('/api/me')).status()).toBe(401); } finally { await context.dispose(); }
});
