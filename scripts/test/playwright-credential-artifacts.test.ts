import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? filesBelow(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

it.each(['list', 'json', 'debug-protocol', 'debug-file', 'debug-file-protocol', 'environment-reporter'] as const)('keeps runtime credentials out of actual failure outputs with %s', async (mode) => {
  const password = randomUUID() + randomUUID();
  let submitted = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/login' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += String(chunk);
      submitted = new URLSearchParams(body).get('password') === password;
      response.writeHead(401, { 'content-type': 'application/json' }); response.end('{}'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html lang="en"><title>Synthetic login</title><body><main>
      <form><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>
      <p role="alert"></p><script>document.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault(); await fetch('/login', { method: 'POST', body: new URLSearchParams(new FormData(event.target)) });
        document.querySelector('[role=alert]').textContent = 'Sign in rejected';
      });</script></main></body></html>`);
  });
  await mkdir(join(root, 'test-results'), { recursive: true });
  const directory = await mkdtemp(join(root, 'test-results/privacy-regression-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Synthetic HTTP server did not start.');
    const configPath = join(directory, 'playwright.config.mts');
    await writeFile(configPath, `import config from ${JSON.stringify(pathToFileURL(join(root, 'playwright.config.ts')).href)};
      const aws = config.projects.find(project => project.name === 'aws');
      export default { ...config, testDir: ${JSON.stringify(directory)}, outputDir: ${JSON.stringify(join(directory, 'results'))},
        reporter: ${mode === 'json' ? "'json'" : 'config.reporter'},
        projects: [{ ...aws, testIgnore: [] }] };`);
    await writeFile(join(directory, 'failed-login.spec.ts'), `import { test, expect } from ${JSON.stringify(pathToFileURL(join(root, 'tests/e2e/fixtures.ts')).href)};
      test('synthetic failed login @aws', async ({ page }) => {
        await page.goto(process.env.PORTAL_SYNTHETIC_URL);
        await page.getByLabel('Email', { exact: true }).fill('synthetic@example.invalid');
        await page.getByLabel('Password', { exact: true }).fill(process.env.PORTAL_SYNTHETIC_PASSWORD);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText('Sign in rejected');
        throw new Error('Synthetic post-fill login failure');
      });`);
    const env: NodeJS.ProcessEnv = { ...process.env, PORTAL_E2E_AWS: '1', PORTAL_SYNTHETIC_URL: `http://127.0.0.1:${address.port}`, PORTAL_SYNTHETIC_PASSWORD: password };
    if (mode === 'debug-protocol' || mode === 'debug-file-protocol') env.DEBUG = 'pw:protocol';
    if (mode === 'debug-file' || mode === 'debug-file-protocol') env.DEBUG_FILE = join(directory, 'protocol.log');
    if (mode === 'environment-reporter') env.PW_TEST_REPORTER = 'json';
    delete env.PLAYWRIGHT_NO_COPY_PROMPT; // The repository config must establish privacy before the worker starts.
    child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', configPath, '--project=aws'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); }); child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 45_000);
    const [exitCode] = await once(child, 'exit').finally(() => clearTimeout(timeout));
    expect(exitCode).toBe(1);
    const files = await filesBelow(directory);
    const contexts = files.filter((path) => path.endsWith('error-context.md'));
    expect(contexts.length).toBeGreaterThan(0);
    const leaked: string[] = output.includes(password) ? ['process output'] : [];
    for (const path of files) {
      const contents = await readFile(path);
      if (contents.includes(Buffer.from(password))) leaked.push(relative(directory, path));
    }
    expect({ submitted, leaked }, 'Only the normal list reporter may submit; outputs must never retain the runtime password.').toEqual({ submitted: mode === 'list', leaked: [] });
    expect(output.includes(mode === 'list' ? 'Synthetic post-fill login failure' : 'AWS browser artifacts must be disabled')).toBe(true);
    expect(files.map((path) => relative(directory, path)).filter((path) => /\.zip$|storage.?state|\.webm$|\.png$|\.html$/.test(path))).toEqual([]);
    for (const path of contexts) expect((await readFile(path, 'utf8')).includes('# Page snapshot')).toBe(false);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true }); // Even a RED regression must leave no synthetic credential artifact behind.
  }
}, 60_000);
