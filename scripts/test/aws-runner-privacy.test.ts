import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;
beforeEach(() => { vi.resetModules(); vi.stubEnv('PORTAL_E2E_AWS', '1'); vi.stubEnv('PLAYWRIGHT_NO_COPY_PROMPT', ''); });
afterEach(() => { process.argv = originalArgv; vi.unstubAllEnvs(); });
const evaluateConfig = () => import('../../playwright.config.js');

describe('AWS privacy at public config evaluation', () => {
  it.each([
    ['test', '--debug'], ['test', '--debug=cli'], ['test', '--debug', 'cli'],
    ['test', '--debug=inspector'], ['test', '--debug', 'inspector'], ['test', '--ui'],
    ['test', '--ui-host=127.0.0.1'], ['test', '--ui-host', '127.0.0.1'],
    ['test', '--ui-port=0'], ['test', '--ui-port', '0'],
    ['test-server'], ['run-test-mcp-server'],
  ].map((args) => ({ args, label: args.join(' ') })))('rejects interactive runner arguments $label before returning configuration', async ({ args }) => {
    process.argv = ['node', 'playwright/cli.js', ...args];
    await expect(evaluateConfig()).rejects.toThrow(/AWS browser artifacts must be disabled/);
  });
  it.each([
    ['PWPAUSE', '1'], ['PWPAUSE', '0'], ['PWTEST_WATCH', '1'],
    ['PWDEBUG', 'console'], ['npm_config_pwdebug', '1'], ['npm_package_config_pwdebug', '1'],
  ])('rejects the installed runner environment %s before returning configuration', async (name, value) => {
    process.argv = ['node', 'playwright/cli.js', 'test']; vi.stubEnv(name!, value!);
    await expect(evaluateConfig()).rejects.toThrow(/AWS browser artifacts must be disabled/);
  });
  it('preserves normal option values and literal arguments after the CLI terminator', async () => {
    process.argv = ['node', 'playwright/cli.js', 'test', '--grep=--debug', '--', '--ui'];
    const projects = (await evaluateConfig()).default.projects;
    expect(projects?.map((project) => project.name)).toEqual(['local-desktop', 'local-mobile', 'aws', 'aws-mobile']);
    expect(projects?.find((project) => project.name === 'aws-mobile')?.use).toMatchObject({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      trace: 'off', video: 'off', screenshot: 'off',
    });
  });
  it('leaves local-only interactive runs available while AWS is disabled', async () => {
    vi.stubEnv('PORTAL_E2E_AWS', ''); process.argv = ['node', 'playwright/cli.js', 'test', '--ui'];
    expect((await evaluateConfig()).default.projects?.find((project) => project.name === 'aws')?.testIgnore).toEqual(['**/*']);
  });
});
