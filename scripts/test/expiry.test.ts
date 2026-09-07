import { expect, test } from 'vitest';
import { deploymentExpiry } from '../expiry.js';

test('binds the AWS safeguard to an absolute maximum lifetime', () => {
  expect(deploymentExpiry(new Date('2030-06-01T12:00:00.000Z'), 6)).toEqual({
    createdAt: '2030-06-01T12:00:00.000Z', expiresAt: '2030-06-01T18:00:00.000Z',
  });
  expect(() => deploymentExpiry(new Date('invalid'), 6)).toThrow(/lifetime/i);
  expect(() => deploymentExpiry(new Date(), 6.01)).toThrow(/lifetime/i);
});
