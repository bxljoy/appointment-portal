import { stdout } from 'node:process';

export type CompletionLog = {
  requestId: string;
  operation: string;
  status: number;
  durationMs: number;
  errorCode: string | null;
  coldStart: boolean;
};

export const writeCompletionLog = (
  event: CompletionLog & Record<string, unknown>,
  // Lambda's JSON console wrapper would put a serialized string in `message`.
  // A single stdout JSON line preserves these application fields at the top level.
  write: (line: string) => void = (line) => { stdout.write(`${line}\n`); },
): void => {
  const { requestId, operation, status, durationMs, errorCode, coldStart } = event;
  write(JSON.stringify({ requestId, operation, status, durationMs, errorCode, coldStart }));
};
