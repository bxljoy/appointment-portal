import { InvokeCommand, LambdaClient, type InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { MigrationPayloadSchema, MigrationResultSchema, type MigrationPayload, type MigrationResult } from '../packages/database/src/lambda.js';

export type LambdaSender = { send: (command: InvokeCommand) => Promise<Pick<InvokeCommandOutput, 'Payload' | 'FunctionError' | 'StatusCode'>> };
export const invokeMigration = async (name: string, payload: MigrationPayload, client?: LambdaSender): Promise<MigrationResult & { ok: true }> => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !MigrationPayloadSchema.safeParse(payload).success) throw new Error('Invalid setup invocation.');
  try {
    const response = await (client ?? new LambdaClient({})).send(new InvokeCommand({
      FunctionName: name, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(payload)),
    }));
    if (response.StatusCode !== 200 || response.FunctionError || !response.Payload) throw new Error('Invoke failed.');
    const result = MigrationResultSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.Payload)));
    if (!result.ok) throw new Error('Setup failed.');
    return result;
  } catch { throw new Error('Private setup invocation failed.'); }
};
