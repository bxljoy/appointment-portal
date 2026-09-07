import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { acquireTokensWithConfig, completeManagedLogin, validateAwsRuntimeConfig } from '../../tests/e2e/aws-support.js';

const origin = 'https://portal.example';
const config = {
  mode: 'cognito', apiBaseUrl: '/api',
  issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_fixture',
  clientId: 'public-client', cognitoDomain: 'https://portal.auth.eu-north-1.amazoncognito.com',
  redirectUri: `${origin}/auth/callback`, logoutUri: `${origin}/signed-out`,
} as const;

it('accepts only the deployed same-origin callbacks and matching AWS Cognito region', () => {
  expect(validateAwsRuntimeConfig(config, origin)).toEqual(config);
  for (const patch of [
    { cognitoDomain: 'https://login.example.invalid' },
    { cognitoDomain: 'https://portal.auth.us-east-1.amazoncognito.com' },
    { issuer: 'https://issuer.example.invalid/pool' },
    { redirectUri: 'https://other.example/auth/callback' },
  ]) expect(() => validateAwsRuntimeConfig({ ...config, ...patch }, origin)).toThrow(/configuration/i);
});

it('handles both a visible Cognito form and an immediate managed-login SSO callback', async () => {
  const submit = vi.fn(async () => {});
  await expect(completeManagedLogin({ callback: Promise.resolve('sso'), waitForCredentialForm: async () => new Promise(() => {}),
    submitCredentials: submit })).resolves.toBe('sso');
  expect(submit).not.toHaveBeenCalled();
  let finish!: (value: string) => void;
  const callback = new Promise<string>((resolve) => { finish = resolve; });
  const formSubmit = vi.fn(async () => { finish('form'); });
  await expect(completeManagedLogin({ callback, waitForCredentialForm: async () => {}, submitCredentials: formSubmit })).resolves.toBe('form');
  expect(formSubmit).toHaveBeenCalledTimes(1);
});

it('intercepts the callback before SPA code and performs exactly one state, nonce, and PKCE-bound exchange', async () => {
  let tokenExchanges = 0;
  let callbackDocuments = 0;
  let authorization: URL | undefined;
  const exchangeBodies: URLSearchParams[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/oauth2/authorize') {
      authorization = url;
      response.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=one-use-code&state=${url.searchParams.get('state')}` });
      response.end(); return;
    }
    if (url.pathname === '/auth/callback') {
      callbackDocuments += 1;
      response.end('<script>fetch("/oauth2/token",{method:"POST"})</script>'); return;
    }
    if (url.pathname === '/oauth2/token') {
      tokenExchanges += 1;
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        const fields = new URLSearchParams(body);
        exchangeBodies.push(fields);
        const jwt = (claims: object) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, filler: 'x'.repeat(100) })).toString('base64url')}.signature`;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ access_token: jwt({ token_use: 'access' }), id_token: jwt({ token_use: 'id', nonce: authorization?.searchParams.get('nonce') }),
          expires_in: 300, token_type: 'Bearer', scope: 'openid profile portal/access' }));
      }); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const tokens = await acquireTokensWithConfig(page, { mode: 'cognito', apiBaseUrl: '/api', issuer: `${origin}/pool`, clientId: 'client',
      cognitoDomain: origin, redirectUri: `${origin}/auth/callback`, logoutUri: `${origin}/signed-out` }, 'openid profile portal/access', async () => {});
    expect(tokens.access_token).toBeTruthy();
    expect(authorization?.searchParams.get('response_type')).toBe('code');
    expect(authorization?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization?.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(authorization?.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenExchanges).toBe(1);
    expect(exchangeBodies[0]?.get('code')).toBe('one-use-code');
    expect(exchangeBodies[0]?.get('grant_type')).toBe('authorization_code');
    expect(createHash('sha256').update(exchangeBodies[0]?.get('code_verifier') ?? '').digest('base64url')).toBe(authorization?.searchParams.get('code_challenge'));
    expect(callbackDocuments).toBe(0);
    await expect(page.title()).resolves.toBe('OAuth callback captured');
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 20_000);
