import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { parsePortalConfig } from '../lib/config.js';
import { PortalStack } from '../lib/portal-stack.js';

const valid = {
  account: '111111111111', region: 'eu-north-1', postgresVersion: '17.6',
  phase: 'bootstrap' as const, qualifier: 'portal123',
};

describe('deployment configuration', () => {
  it('accepts concrete bootstrap and ready configurations', () => {
    expect(parsePortalConfig(valid)).toEqual(valid);
    const ready = { ...valid, phase: 'ready', frontendUrl: 'https://demo.cloudfront.net' };
    expect(parsePortalConfig(ready)).toEqual(ready);
  });

  it.each([
    null, [], {}, { ...valid, extra: true },
    ...['account', 'region', 'postgresVersion', 'phase', 'qualifier'].map((key) => ({ ...valid, [key]: undefined })),
    ...['', '123', '11111111111a', ' 111111111111', 111111111111].map((account) => ({ ...valid, account })),
    ...['', 'eu-north', 'EU-NORTH-1', '${AWS::Region}', 'eu-north-1 '].map((region) => ({ ...valid, region })),
    ...['17', '16.6', '18.1', '17.0', '17.x', '17.06', '17.6.1', 17.6].map((postgresVersion) => ({ ...valid, postgresVersion })),
    ...['', 'production', 'READY'].map((phase) => ({ ...valid, phase })),
    ...['', 'with-dash', '12345678901', '${Token}', 123].map((qualifier) => ({ ...valid, qualifier })),
    { ...valid, phase: 'ready' },
    ...['http://demo.cloudfront.net', 'https://demo.cloudfront.net/callback', 'https://demo.cloudfront.net?x=1',
      'https://demo.cloudfront.net#fragment', 'https://user:password@demo.cloudfront.net',
      'https://localhost', 'https://127.0.0.1', 'not a url', ''].map((frontendUrl) => ({ ...valid, frontendUrl })),
  ])('rejects unsafe or incomplete configuration %#', (input) => {
    expect(() => parsePortalConfig(input)).toThrow();
  });

  it('rejects stack environment differing from validated configuration', () => {
    expect(() => new PortalStack(new App(), 'Mismatch', {
      env: { account: '222222222222', region: valid.region }, config: valid,
    })).toThrow(/environment/i);
  });
});
