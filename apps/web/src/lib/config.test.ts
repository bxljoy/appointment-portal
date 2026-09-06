import { describe, expect, it } from 'vitest';
import { parsePublicConfig } from './config';
const origin = 'https://portal.example';
export const cognitoConfig = { mode: 'cognito', apiBaseUrl: '/api', issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/pool', clientId: 'publicclient', cognitoDomain: 'https://portal.auth.eu-north-1.amazoncognito.com', redirectUri: `${origin}/auth/callback`, logoutUri: `${origin}/signed-out` } as const;
describe('public config', () => {
  it('requires Cognito in production', () => { expect(() => parsePublicConfig({ mode: 'local', apiBaseUrl: '/api' }, true, origin)).toThrow(); });
  it('accepts local development only and complete Cognito config', () => {
    expect(parsePublicConfig({ mode: 'local', apiBaseUrl: '/api' }, false, origin).mode).toBe('local');
    expect(parsePublicConfig(cognitoConfig, true, origin)).toEqual(cognitoConfig);
  });
  it.each([{ clientId: '' }, { issuer: '' }, { issuer: 'http://insecure.example' }, { cognitoDomain: 'https://portal.example/logout?extra=yes' }, { redirectUri: 'https://evil.example/auth/callback' }, { logoutUri: `${origin}/wrong-path` }, { apiBaseUrl: 'https://evil.example/api' }, { clientSecret: 'not-allowed' }])('rejects incomplete or unsafe config %j', (patch) => { expect(() => parsePublicConfig({ ...cognitoConfig, ...patch }, true, origin)).toThrow(); });
});
