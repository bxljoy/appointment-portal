import { describe, expect, it } from 'vitest';
import { offlineSynthContextArgs } from '../offline-synth-context.mjs';

describe.each(['bootstrap', 'ready'] as const)('offline %s synthesis context', (phase) => {
  it('supplies the complete immutable repository identity contract', () => {
    const args = offlineSynthContextArgs(phase);
    const contexts = args.flatMap((arg, index) => arg === '-c' ? [args[index + 1]] : []);
    expect(contexts).toEqual(expect.arrayContaining([
      'repository=OWNER/REPOSITORY',
      'repositoryOwnerId=12345678',
      'repositoryId=87654321',
      `phase=${phase}`,
    ]));
  });
});
