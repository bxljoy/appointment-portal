import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { z } from 'zod';
import { awsCredential } from './fixtures.js';
import type { Account } from './local-auth.setup.js';
import { isAwsRequestId } from '../../scripts/aws-request-id.js';
import { assertManagedLoginOrigin, validatePublicCognitoConfig, type AwsAuthority } from '../../scripts/aws-authority.js';

const configSchema = z.strictObject({
  mode: z.literal('cognito'), apiBaseUrl: z.literal('/api'), issuer: z.url().startsWith('https://'),
  clientId: z.string().min(1), cognitoDomain: z.url().startsWith('https://'),
  redirectUri: z.url().startsWith('https://'), logoutUri: z.url().startsWith('https://'),
});
const tokenSchema = z.object({ access_token: z.string().min(100), id_token: z.string().min(100),
  refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), token_type: z.literal('Bearer'), scope: z.string() });

export type AwsTokens = z.infer<typeof tokenSchema>;
export type AwsRuntimeConfig = z.infer<typeof configSchema>;

export function validateAwsRuntimeConfig(raw: unknown, expected: AwsAuthority): AwsRuntimeConfig {
  const config = configSchema.parse(raw);
  return validatePublicCognitoConfig(config, expected);
}

const expectedAuthority = (): AwsAuthority => ({
  account: process.env.PORTAL_E2E_AWS_ACCOUNT ?? '', region: process.env.PORTAL_E2E_AWS_REGION ?? '',
  issuer: process.env.PORTAL_E2E_AWS_ISSUER ?? '', clientId: process.env.PORTAL_E2E_AWS_CLIENT_ID ?? '',
  userPoolId: process.env.PORTAL_E2E_AWS_USER_POOL_ID ?? '', cognitoDomain: process.env.PORTAL_E2E_AWS_COGNITO_DOMAIN ?? '',
  frontendUrl: process.env.PORTAL_E2E_AWS_URL ?? '',
});

export async function awsRuntimeConfig(page: Page): Promise<AwsRuntimeConfig> {
  const response = await page.request.get(new URL('/config.json', page.url()).href);
  if (!response.ok()) throw new Error('Deployed public configuration is unavailable.');
  return validateAwsRuntimeConfig(await response.json(), expectedAuthority());
}

export async function credentialAfterAuthority<T>(currentUrl: string, authority: AwsAuthority, read: () => Promise<T>): Promise<T> {
  assertManagedLoginOrigin(currentUrl, authority);
  return read();
}

async function submitManagedLogin(page: Page, account: Account, authority: AwsAuthority): Promise<void> {
  try {
    const credential = await credentialAfterAuthority(page.url(), authority, () => awsCredential(account));
    assertManagedLoginOrigin(page.url(), authority);
    await page.getByLabel('Email', { exact: true }).fill(credential.email);
    assertManagedLoginOrigin(page.url(), authority);
    await page.getByLabel('Password', { exact: true }).fill(credential.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } catch {
    throw new Error('Managed login could not submit the controlled account; no credential diagnostics were retained.');
  }
}

type ManagedLoginOutcome<T> = { kind: 'callback'; value: T } | { kind: 'form' };
export async function completeManagedLogin<T>(input: {
  callback: Promise<T>; waitForCredentialForm: () => Promise<void>; submitCredentials: () => Promise<void>;
}): Promise<T> {
  const outcome = await Promise.race<ManagedLoginOutcome<T>>([
    input.callback.then((value) => ({ kind: 'callback', value })),
    input.waitForCredentialForm().then(() => ({ kind: 'form' })),
  ]);
  if (outcome.kind === 'callback') return outcome.value;
  await input.submitCredentials();
  return input.callback;
}

const credentialFormVisible = async (page: Page) => {
  await page.getByLabel('Email', { exact: true }).waitFor({ state: 'visible' });
};

export async function signInThroughApplication(page: Page, account: Account): Promise<{ tokens: AwsTokens; authorizationUrl: URL }> {
  const config = await awsRuntimeConfig(page);
  const authority = expectedAuthority();
  const tokenResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
    response.url() === new URL('/oauth2/token', config.cognitoDomain).href);
  const authorizationRequest = page.waitForRequest((request) => request.method() === 'GET' &&
    request.url().startsWith(new URL('/oauth2/authorize', config.cognitoDomain).href));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const authorizationUrl = new URL((await authorizationRequest).url());
  const response = await completeManagedLogin({ callback: tokenResponse, waitForCredentialForm: () => credentialFormVisible(page),
    submitCredentials: () => submitManagedLogin(page, account, authority) });
  if (!response.ok()) throw new Error('Managed token exchange failed.');
  const tokens = tokenSchema.parse(await response.json());
  await page.waitForURL((url) => url.origin === new URL(config.redirectUri).origin);
  return { tokens, authorizationUrl };
}

export async function acquireTokens(page: Page, account: Account, scope = 'openid profile portal/access'): Promise<AwsTokens> {
  const config = await awsRuntimeConfig(page);
  return acquireTokensWithConfig(page, config, scope,
    () => submitManagedLogin(page, account, expectedAuthority()));
}

export async function acquireTokensWithConfig(page: Page, config: AwsRuntimeConfig, scope: string,
  submitCredentials: () => Promise<void>): Promise<AwsTokens> {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const authorize = new URL('/oauth2/authorize', config.cognitoDomain);
  for (const [name, value] of Object.entries({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri,
    scope, code_challenge_method: 'S256', code_challenge: challenge, state, nonce })) authorize.searchParams.set(name, value);
  const callbackTarget = new URL(config.redirectUri);
  let resolveIntercepted!: (url: URL) => void;
  const intercepted = new Promise<URL>((resolve) => { resolveIntercepted = resolve; });
  const callbackMatcher = `${new URL(config.cognitoDomain).origin}/**`;
  await page.route(callbackMatcher, async (route) => {
    const candidate = new URL(route.request().url());
    if (candidate.origin === callbackTarget.origin && candidate.pathname === callbackTarget.pathname) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>OAuth callback captured</title>' });
      resolveIntercepted(candidate); return;
    }
    const upstream = await route.fetch({ maxRedirects: 0 });
    const location = upstream.headers().location;
    if (upstream.status() >= 300 && upstream.status() < 400 && location) {
      const redirect = new URL(location, candidate);
      if (redirect.origin === callbackTarget.origin && redirect.pathname === callbackTarget.pathname) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>OAuth callback captured</title>' });
        resolveIntercepted(redirect); return;
      }
    }
    await route.fulfill({ response: upstream });
  });
  try {
    await page.goto(authorize.href);
    const callback = await completeManagedLogin({ callback: intercepted, waitForCredentialForm: () => credentialFormVisible(page), submitCredentials });
    if (callback.searchParams.get('state') !== state) throw new Error('Managed login returned an invalid OAuth state.');
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Managed login did not return an authorization code.');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
      redirect_uri: config.redirectUri, code, code_verifier: verifier });
    const response = await fetch(new URL('/oauth2/token', config.cognitoDomain), { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, redirect: 'error' });
    if (!response.ok) throw new Error('Managed token exchange failed.');
    const tokens = tokenSchema.parse(await response.json());
    if (jwtClaims(tokens.id_token).nonce !== nonce) throw new Error('Managed login returned an invalid OAuth nonce.');
    return tokens;
  } finally {
    await page.unroute(callbackMatcher);
  }
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
  if (!requestId || !isAwsRequestId(requestId)) throw new Error('The deployed API response omitted a valid request ID.');
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
