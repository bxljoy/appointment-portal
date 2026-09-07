import { FilterLogEventsCommand, type CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { z } from 'zod';
import { isAwsRequestId } from './aws-request-id.js';

export type CorrelationSummary = { requestCount: number; coldCount: number; warmCount: number; maxDurationMs: number };
export type CorrelationSource = { page(requestId: string, cursor?: string): Promise<{ events: Array<{ message?: string }>; nextToken?: string }> };

const eventSchema = z.object({
  requestId: z.string(), operation: z.string().regex(/^[A-Z]+ \/api\/[A-Za-z0-9_/:*-]{1,100}$/),
  status: z.number().int().min(100).max(599), durationMs: z.number().int().nonnegative().max(15_000),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).nullable(), coldStart: z.boolean(),
});

export async function correlateRequestLogs(requestIds: string[], source: CorrelationSource): Promise<CorrelationSummary> {
  if (!requestIds.length || requestIds.some((id) => !isAwsRequestId(id)) || new Set(requestIds).size !== requestIds.length) {
    throw new Error('CloudWatch correlation requires unique valid request IDs.');
  }
  const records: Array<z.infer<typeof eventSchema>> = [];
  for (const requestId of requestIds) {
    const seen = new Set<string>();
    let cursor: string | undefined;
    const matched: Array<z.infer<typeof eventSchema>> = [];
    do {
      if (cursor && seen.has(cursor)) throw new Error('CloudWatch pagination token repeated.');
      if (cursor) seen.add(cursor);
      const page = await source.page(requestId, cursor);
      for (const item of page.events) {
        if (!item.message || Buffer.byteLength(item.message, 'utf8') > 4_096) continue;
        try {
          const parsed = eventSchema.parse(JSON.parse(item.message));
          if (parsed.requestId === requestId) matched.push(parsed);
        } catch { /* Ignore unrelated log lines. */ }
      }
      cursor = page.nextToken;
    } while (cursor !== undefined);
    if (matched.length === 0) throw new Error(`CloudWatch request evidence is missing for request ${requestId}.`);
    if (matched.length !== 1) throw new Error(`CloudWatch did not return exactly one completion record for request ${requestId}.`);
    records.push(matched[0]!);
  }
  return { requestCount: records.length, coldCount: records.filter((record) => record.coldStart).length,
    warmCount: records.filter((record) => !record.coldStart).length,
    maxDurationMs: Math.max(...records.map((record) => record.durationMs)) };
}

export const cloudWatchCorrelationAdapter = (client: Pick<CloudWatchLogsClient, 'send'>, logGroupNames: readonly string[], options: {
  attempts?: number; sleep?: (milliseconds: number) => Promise<void>;
} = {}) => ({
  observe: async (requestIds: string[]) => {
    const source: CorrelationSource = {
      page: async (requestId, nextToken) => {
        if (!logGroupNames.length) throw new Error('CloudWatch log groups are required.');
        const cursorSchema = z.strictObject({ group: z.number().int().nonnegative(), token: z.string().optional() });
        const cursor = nextToken ? cursorSchema.parse(JSON.parse(Buffer.from(nextToken, 'base64url').toString('utf8'))) : { group: 0 };
        const logGroupName = logGroupNames[cursor.group];
        if (!logGroupName) throw new Error('CloudWatch correlation cursor is outside the log-group allowlist.');
        const page = await client.send(new FilterLogEventsCommand({ logGroupName, filterPattern: `{ $.requestId = "${requestId}" }`,
          ...(cursor.token ? { nextToken: cursor.token } : {}) }));
        const next = page.nextToken ? { group: cursor.group, token: page.nextToken } :
          cursor.group + 1 < logGroupNames.length ? { group: cursor.group + 1 } : undefined;
        return { events: (page.events ?? []).map(({ message }) => ({ ...(message ? { message } : {}) })),
          ...(next ? { nextToken: Buffer.from(JSON.stringify(next)).toString('base64url') } : {}) };
      },
    };
    const attempts = options.attempts ?? 6;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await correlateRequestLogs(requestIds, source); }
      catch (error) {
        if (attempt === attempts) throw error;
        await (options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(2_000);
      }
    }
    throw new Error('CloudWatch correlation exhausted its bounded retry window.');
  },
});
