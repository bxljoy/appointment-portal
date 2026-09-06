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
  it.each<Partial<RecordingOptions>>([
    { trace: 'on' }, { trace: 'retain-on-failure' }, { screenshot: 'only-on-failure' }, { video: 'retain-on-failure' },
    { storageState: 'storage-state/account.json' }, { storageState: { cookies: [], origins: [{ origin: 'https://example.invalid', localStorage: [] }] } },
    { contextOptions: { recordHar: { path: 'reports/login.har' } } }, { contextOptions: { recordVideo: { dir: 'reports' } } },
    { contextOptions: { storageState: 'storage-state/account.json' } },
  ])('rejects recording or persisted-session overrides %#', (override) => {
    expect(() => assertAwsArtifactPrivacy([['list']], { ...safe, ...override })).toThrow(/artifacts must be disabled/);
  });
});
