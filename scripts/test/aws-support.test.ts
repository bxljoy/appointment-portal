import { expect, it } from 'vitest';
import { validateAwsRuntimeConfig } from '../../tests/e2e/aws-support.js';

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
