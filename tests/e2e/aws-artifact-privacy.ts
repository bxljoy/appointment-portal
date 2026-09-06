import type { FullConfig, PlaywrightTestOptions, PlaywrightWorkerOptions } from '@playwright/test';

export type RecordingOptions = Pick<PlaywrightTestOptions & PlaywrightWorkerOptions, 'trace' | 'video' | 'screenshot' | 'storageState' | 'contextOptions'>;
export function assertAwsArtifactPrivacy(reporter: FullConfig['reporter'], options: RecordingOptions) {
  const state = options.storageState;
  const emptyState = typeof state === 'object' && state !== null && state.cookies.length === 0 && state.origins.length === 0;
  const recordsContext = ['recordHar', 'recordVideo', 'storageState'].some((key) => key in options.contextOptions);
  // HTML/JSON/blob reporters can retain the arguments of successful fill steps even when tracing is off.
  if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== '1' || reporter.length !== 1 || reporter[0]?.[0] !== 'list' ||
      options.trace !== 'off' || options.video !== 'off' || options.screenshot !== 'off' || !emptyState || recordsContext) {
    throw new Error('AWS browser artifacts must be disabled before entering credentials.');
  }
}
