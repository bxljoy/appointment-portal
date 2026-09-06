import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertAwsArtifactPrivacy, type RecordingOptions } from '../../tests/e2e/aws-artifact-privacy.js';

const safe: RecordingOptions = { trace: 'off', video: 'off', screenshot: 'off', storageState: { cookies: [], origins: [] }, contextOptions: {} };
beforeEach(() => { vi.stubEnv('PLAYWRIGHT_NO_COPY_PROMPT', '1'); });
afterEach(() => { vi.unstubAllEnvs(); });
describe('AWS recording boundary', () => {
  it('accepts only the configured non-recording defaults', () => expect(() => assertAwsArtifactPrivacy([['list']], safe)).not.toThrow());
  it('requires snapshot suppression before the worker uses credentials', () => {
    vi.stubEnv('PLAYWRIGHT_NO_COPY_PROMPT', '');
    expect(() => assertAwsArtifactPrivacy([['list']], safe)).toThrow(/artifacts must be disabled/);
  });
  it.each(['json', 'html', 'blob', 'junit', './custom-reporter.ts'])('rejects %s reporters which can retain credential entry steps', (reporter) => {
    expect(() => assertAwsArtifactPrivacy([[reporter]], safe)).toThrow(/artifacts must be disabled/);
  });
  it.each([
    ['DEBUG', 'pw:protocol'], ['DEBUG', 'other-library'], ['DEBUG', ' '], ['DEBUG_FILE', 'diagnostics.log'],
    ['PWDEBUG', 'console'], ['PWDEBUG', '0'], ['npm_config_pwdebug', '1'], ['npm_package_config_pwdebug', '1'],
    ['PWDEBUGIMPL', '1'], ['PW_TEST_DEBUG_REPORTERS', '1'], ['PW_RUNNER_DEBUG', '1'], ['PWTEST_DEBUG', '1'],
    ['PW_TEST_REPORTER', 'json'], ['PLAYWRIGHT_DASHBOARD', '1'], ['PW_DEBUG_CONTROLLER_HEADLESS', '1'], ['PW_INSTRUMENT_MODULES', '1'],
  ])('rejects diagnostic environment %s=%s before credentials', (name, value) => {
    vi.stubEnv(name!, value!);
    expect(() => assertAwsArtifactPrivacy([['list']], safe)).toThrow(/artifacts must be disabled/);
  });
  it.each<Partial<RecordingOptions>>([
    { trace: 'on' }, { trace: 'retain-on-failure' }, { screenshot: 'only-on-failure' }, { video: 'retain-on-failure' },
    { storageState: 'storage-state/account.json' }, { storageState: { cookies: [], origins: [{ origin: 'https://example.invalid', localStorage: [] }] } },
    { contextOptions: { recordHar: { path: 'reports/login.har' } } }, { contextOptions: { recordVideo: { dir: 'reports' } } },
    { contextOptions: { storageState: 'storage-state/account.json' } },
  ])('rejects recording or persisted-session overrides %#', (override) => {
    expect(() => assertAwsArtifactPrivacy([['list']], { ...safe, ...override })).toThrow(/artifacts must be disabled/);
  });
});
