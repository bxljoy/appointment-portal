import type { FullConfig, PlaywrightTestOptions, PlaywrightWorkerOptions } from '@playwright/test';

export type RecordingOptions = Pick<PlaywrightTestOptions & PlaywrightWorkerOptions, 'trace' | 'video' | 'screenshot' | 'storageState' | 'contextOptions'>;
const diagnosticEnvironment = [
  'DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'npm_config_pwdebug', 'npm_package_config_pwdebug', 'PWDEBUGIMPL',
  'PW_TEST_DEBUG_REPORTERS', 'PW_RUNNER_DEBUG', 'PWTEST_DEBUG', 'PW_TEST_REPORTER',
  'PLAYWRIGHT_DASHBOARD', 'PW_DEBUG_CONTROLLER_HEADLESS', 'PW_INSTRUMENT_MODULES',
  'PWPAUSE', 'PWTEST_WATCH',
];
const interactiveOptions = new Set(['--debug', '--ui', '--ui-host', '--ui-port']);
const interactiveCommands = new Set(['test-server', 'run-test-mcp-server']);

export function assertAwsRunnerPrivacy() {
  const args = process.argv.slice(2);
  const terminator = args.indexOf('--');
  const options = terminator === -1 ? args : args.slice(0, terminator);
  // --debug=cli does not set PWDEBUG; UI mode injects a wire reporter outside config.reporter.
  // Reject these before config returns so the runner cannot pause before fixtures execute.
  const interactive = interactiveCommands.has(options[0] ?? '') || options.some((arg) => interactiveOptions.has(arg.split('=')[0]!));
  // Protocol logs can contain raw Input.insertText payloads. PWDEBUG also reads npm aliases;
  // PWPAUSE and PWTEST_WATCH use direct environment reads, including nonempty "0" values.
  const diagnostics = diagnosticEnvironment.some((name) => Boolean(process.env[name]));
  if (interactive || diagnostics) throw new Error('AWS browser artifacts must be disabled before entering credentials.');
}

export function assertAwsArtifactPrivacy(reporter: FullConfig['reporter'], options: RecordingOptions) {
  assertAwsRunnerPrivacy();
  const state = options.storageState;
  const emptyState = typeof state === 'object' && state !== null && state.cookies.length === 0 && state.origins.length === 0;
  const recordsContext = ['recordHar', 'recordVideo', 'storageState'].some((key) => key in options.contextOptions);
  // HTML/JSON/blob reporters can retain the arguments of successful fill steps even when tracing is off.
  if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1' || reporter.length !== 1 || reporter[0]?.[0] !== 'list' ||
      options.trace !== 'off' || options.video !== 'off' || options.screenshot !== 'off' || !emptyState || recordsContext) {
    throw new Error('AWS browser artifacts must be disabled before entering credentials.');
  }
}
