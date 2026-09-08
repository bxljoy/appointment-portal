import { expect, test } from 'vitest';
import { deploymentExpiry } from '../expiry.js';
import { parseAwsDemoInput } from '../aws-lifecycle.js';
import { manifest } from './fakes.js';

test('binds the AWS safeguard to an absolute maximum lifetime', () => {
  expect(deploymentExpiry(new Date('2030-06-01T12:00:00.000Z'), 6)).toEqual({
    createdAt: '2030-06-01T12:00:00.000Z', expiresAt: '2030-06-01T18:00:00.000Z',
  });
  expect(() => deploymentExpiry(new Date('invalid'), 6)).toThrow(/lifetime/i);
  expect(() => deploymentExpiry(new Date(), 6.01)).toThrow(/lifetime/i);
});

test('binds configuration creation and expiry to the current execution clock', () => {
  const now = new Date('2030-06-01T12:00:00.000Z');
  const input = { account: manifest.account, region: manifest.region, postgresVersion: '17.6', durationHours: 2, maxCostUsd: 5,
    repository: 'OWNER/REPOSITORY', repositoryOwnerId: '18458919', repositoryId: '1360681625', branch: 'main', sourceCommit: 'a'.repeat(40), accountsFile: '/private/accounts', priceReport: '/private/prices' };
  const current = { ...input, createdAt: '2030-06-01T11:55:01.000Z', expiresAt: '2030-06-01T13:55:01.000Z' };
  expect(parseAwsDemoInput(current, now)).toMatchObject({ lambdaConcurrencyMode: 'reserved' });
  expect(parseAwsDemoInput({ ...current, lambdaConcurrencyMode: 'shared-unreserved' }, now))
    .toMatchObject({ lambdaConcurrencyMode: 'shared-unreserved' });
  for (const lambdaConcurrencyMode of ['', 'unreserved', 'shared', 'RESERVED', true, 10]) {
    expect(() => parseAwsDemoInput({ ...current, lambdaConcurrencyMode }, now)).toThrow();
  }
  expect(() => parseAwsDemoInput({ ...input, createdAt: '2030-06-01T11:54:59.000Z', expiresAt: '2030-06-01T13:54:59.000Z' }, now)).toThrow(/current execution/i);
  expect(() => parseAwsDemoInput({ ...input, createdAt: '2030-06-01T12:05:01.000Z', expiresAt: '2030-06-01T14:05:01.000Z' }, now)).toThrow(/current execution/i);
  expect(() => parseAwsDemoInput({ ...input, createdAt: '2030-06-01T12:00:00.000Z', expiresAt: '2030-06-01T14:00:00.001Z' }, now)).toThrow(/maximum lifetime/i);
});
