import type { FullConfig, PlaywrightTestOptions, PlaywrightWorkerOptions } from '@playwright/test';

export type RecordingOptions = Pick<PlaywrightTestOptions & PlaywrightWorkerOptions, 'trace' | 'video' | 'screenshot' | 'storageState' | 'contextOptions'>;
const diagnosticEnvironment = [
  'DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'npm_config_pwdebug', 'npm_package_config_pwdebug', 'PWDEBUGIMPL',
  'PW_TEST_DEBUG_REPORTERS', 'PW_RUNNER_DEBUG', 'PWTEST_DEBUG', 'PW_TEST_REPORTER',
  'PLAYWRIGHT_DASHBOARD', 'PW_DEBUG_CONTROLLER_HEADLESS', 'PW_INSTRUMENT_MODULES',
];
export function assertAwsArtifactPrivacy(reporter: FullConfig['reporter'], options: RecordingOptions) {
  const state = options.storageState;
  const emptyState = typeof state === 'object' && state !== null && state.cookies.length === 0 && state.origins.length === 0;
  const recordsContext = ['recordHar', 'recordVideo', 'storageState'].some((key) => key in options.contextOptions);
  // Protocol debugging can log raw Input.insertText payloads; PW_TEST_REPORTER bypasses config.reporter.
  // PWDEBUG is also read through npm's two configuration aliases. Even nonempty "0" values are rejected.
  const diagnostics = diagnosticEnvironment.some((name) => Boolean(process.env[name]));
  // HTML/JSON/blob reporters can retain the arguments of successful fill steps even when tracing is off.
  if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1' || reporter.length !== 1 || reporter[0]?.[0] !== 'list' ||
      options.trace !== 'off' || options.video !== 'off' || options.screenshot !== 'off' || !emptyState || recordsContext || diagnostics) {
    throw new Error('AWS browser artifacts must be disabled before entering credentials.');
  }
}
