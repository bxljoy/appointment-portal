import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';

import { lighthouseCliAdapter } from '../measure-web.js';
import { runProcess, type ProcessRunner } from '../preflight.js';

it('executes the pinned Lighthouse navigation adapter against a real local page', async () => {
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Fixture</title><main>Ready</main>'); });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => { server.off('error', onError); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local Lighthouse fixture did not bind.');
    let lighthouseArgs: string[] = [];
    const runner: ProcessRunner = (_executable, args) => {
      lighthouseArgs = [...args, '--chrome-flags=--no-sandbox'];
      return runProcess(process.execPath, ['node_modules/lighthouse/cli/index.js', ...lighthouseArgs], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CHROME_PATH: chromium.executablePath() } });
    };
    const result = await lighthouseCliAdapter(runner).run({ url: `http://127.0.0.1:${address.port}/`, profile: 'mobile', mode: 'navigation' });
    expect(lighthouseArgs.filter((arg) => arg.startsWith('--chrome-flags='))).toEqual([
      '--chrome-flags=--headless=new', '--chrome-flags=--no-sandbox',
    ]);
    expect(result).toMatchObject({ kind: 'navigation', sessionEvidence: 'public-page' });
    if (result.kind === 'navigation') {
      expect(result.performanceScore).toBeGreaterThan(0);
      expect(Object.keys(result.metrics).sort()).toEqual([
        'cumulativeLayoutShift', 'fcpMs', 'lcpMs', 'speedIndexMs', 'totalBlockingTimeMs',
      ]);
    }
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
