import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertLambdaArtifactsClean } from '../scripts/check-lambda-artifacts.mjs';

describe('Lambda artifact guard', () => {
  it('rejects a production bundle containing the local identity marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portal-lambda-artifact-'));
    try {
      const bundle = join(directory, 'appointments', 'index.mjs');
      await mkdir(join(directory, 'appointments'), { recursive: true });
      await writeFile(bundle, 'const localHeader = "X-Local-Actor";\n');

      await expect(assertLambdaArtifactsClean(directory)).rejects.toThrow('X-Local-Actor');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
