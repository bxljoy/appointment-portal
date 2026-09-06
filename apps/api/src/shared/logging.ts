export type CompletionLog = {
  requestId: string;
  operation: string;
  status: number;
  durationMs: number;
  errorCode: string | null;
};

export const writeCompletionLog = (
  event: CompletionLog & Record<string, unknown>,
  write: (line: string) => void = console.log,
): void => {
  const { requestId, operation, status, durationMs, errorCode } = event;
  write(JSON.stringify({ requestId, operation, status, durationMs, errorCode }));
};
