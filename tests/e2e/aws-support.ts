import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { z } from 'zod';
import { awsCredential } from './fixtures.js';
import type { Account } from './local-auth.setup.js';

const configSchema = z.strictObject({
  mode: z.literal('cognito'), apiBaseUrl: z.literal('/api'), issuer: z.url().startsWith('https://'),
  clientId: z.string().min(1), cognitoDomain: z.url().startsWith('https://'),
  redirectUri: z.url().startsWith('https://'), logoutUri: z.url().startsWith('https://'),
});
const tokenSchema = z.object({ access_token: z.string().min(100), id_token: z.string().min(100),
  refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), token_type: z.literal('Bearer'), scope: z.string() });
const requestIdPattern = /^[A-Za-z0-9_-]{8,128}$/;

export type AwsTokens = z.infer<typeof tokenSchema>;
export type AwsRuntimeConfig = z.infer<typeof configSchema>;

export function validateAwsRuntimeConfig(raw: unknown, origin: string): AwsRuntimeConfig {
  const config = configSchema.parse(raw);
  for (const [value, path] of [[config.redirectUri, '/auth/callback'], [config.logoutUri, '/signed-out']] as const) {
    const url = new URL(value);
    if (url.origin !== origin || url.pathname !== path || url.search || url.hash || url.username || url.password) {
      throw new Error('Deployed Cognito configuration has invalid callback URLs.');
    }
  }
  const issuer = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/[A-Za-z0-9_-]+$/.exec(config.issuer);
  const domain = /^https:\/\/[a-z0-9-]+\.auth\.([a-z0-9-]+)\.amazoncognito\.com$/.exec(config.cognitoDomain);
  if (!issuer || !domain || issuer[1] !== domain[1]) throw new Error('Deployed Cognito configuration is invalid.');
  return config;
}

export async function awsRuntimeConfig(page: Page): Promise<AwsRuntimeConfig> {
  const response = await page.request.get(new URL('/config.json', page.url()).href);
  if (!response.ok()) throw new Error('Deployed public configuration is unavailable.');
  return validateAwsRuntimeConfig(await response.json(), new URL(page.url()).origin);
}

async function submitManagedLogin(page: Page, account: Account, expectedOrigin: string): Promise<void> {
  const credential = await awsCredential(account);
  try {
    if (new URL(page.url()).origin !== expectedOrigin) throw new Error();
    await page.getByLabel('Email', { exact: true }).fill(credential.email);
    await page.getByLabel('Password', { exact: true }).fill(credential.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } catch {
    throw new Error('Managed login could not submit the controlled account; no credential diagnostics were retained.');
  }
}

export async function signInThroughApplication(page: Page, account: Account): Promise<{ tokens: AwsTokens; authorizationUrl: URL }> {
  const config = await awsRuntimeConfig(page);
  const tokenResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
    response.url() === new URL('/oauth2/token', config.cognitoDomain).href);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin === new URL(config.cognitoDomain).origin);
  const authorizationUrl = new URL(page.url());
  await submitManagedLogin(page, account, new URL(config.cognitoDomain).origin);
  const response = await tokenResponse;
  if (!response.ok()) throw new Error('Managed token exchange failed.');
  const tokens = tokenSchema.parse(await response.json());
  await page.waitForURL((url) => url.origin === new URL(config.redirectUri).origin);
  return { tokens, authorizationUrl };
}

export async function acquireTokens(page: Page, account: Account, scope = 'openid profile portal/access'): Promise<AwsTokens> {
  const config = await awsRuntimeConfig(page);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const authorize = new URL('/oauth2/authorize', config.cognitoDomain);
  for (const [name, value] of Object.entries({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri,
    scope, code_challenge_method: 'S256', code_challenge: challenge, state, nonce })) authorize.searchParams.set(name, value);
  await page.goto(authorize.href);
  await submitManagedLogin(page, account, new URL(config.cognitoDomain).origin);
  await page.waitForURL((url) => url.origin === new URL(config.redirectUri).origin && url.searchParams.has('code'));
  const callback = new URL(page.url());
  if (callback.searchParams.get('state') !== state) throw new Error('Managed login returned an invalid OAuth state.');
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('Managed login did not return an authorization code.');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
    redirect_uri: config.redirectUri, code, code_verifier: verifier });
  const response = await fetch(new URL('/oauth2/token', config.cognitoDomain), { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'error' });
  if (!response.ok) throw new Error('Managed token exchange failed.');
  return tokenSchema.parse(await response.json());
}

export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    if (!payload) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error('Managed login returned an invalid JWT shape.'); }
}

type RequestFactory = { request: { newContext(options?: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }): Promise<APIRequestContext> } };
export async function apiContext(playwright: RequestFactory, accessToken: string, direct = false): Promise<APIRequestContext> {
  const baseURL = direct ? process.env.PORTAL_E2E_AWS_API_URL : process.env.PORTAL_E2E_AWS_URL;
  if (!baseURL || new URL(baseURL).protocol !== 'https:') throw new Error('A deployed HTTPS API origin is required.');
  return playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
}

export function recordRequestId(response: APIResponse): string {
  const requestId = response.headers()['x-request-id'];
  if (!requestId || !requestIdPattern.test(requestId)) throw new Error('The deployed API response omitted a valid request ID.');
  process.stdout.write(`PORTAL_REQUEST_ID:${requestId}\n`);
  return requestId;
}

const runMinuteNonce = randomInt(0, 4 * 24 * 60);
export const futureStart = (offsetMinutes: number): string => {
  const time = new Date(Date.now() + 36 * 60 * 60 * 1_000 + (runMinuteNonce + offsetMinutes) * 60_000);
  time.setUTCSeconds(0, 0);
  return time.toISOString();
};

export async function json<T>(response: APIResponse): Promise<T> {
  return await response.json() as T;
}
