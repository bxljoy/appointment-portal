import { FilterLogEventsCommand, type CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { z } from 'zod';
import { isAwsRequestId } from './aws-request-id.js';

export type CorrelationSummary = { requestCount: number; coldCount: number; warmCount: number; maxDurationMs: number };
export type CorrelationWindow = { startTime: number; endTime: number };
export type CorrelationSource = { page(requestId: string, cursor: string | undefined, window: CorrelationWindow): Promise<{ events: Array<{ message?: string; timestamp?: number }>; nextToken?: string }> };

const eventSchema = z.object({
  requestId: z.string(), operation: z.string().regex(/^[A-Z]+ \/api\/[A-Za-z0-9_/:*-]{1,100}$/),
  status: z.number().int().min(100).max(599), durationMs: z.number().int().nonnegative().max(15_000),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).nullable(), coldStart: z.boolean(),
});

export async function correlateRequestLogs(requestIds: string[], source: CorrelationSource, window: CorrelationWindow,
  options: { maxPagesPerRequest?: number } = {}): Promise<CorrelationSummary> {
  if (!requestIds.length || requestIds.some((id) => !isAwsRequestId(id)) || new Set(requestIds).size !== requestIds.length) {
    throw new Error('CloudWatch correlation requires unique valid request IDs.');
  }
  const records: Array<z.infer<typeof eventSchema>> = [];
  if (!Number.isInteger(window.startTime) || !Number.isInteger(window.endTime) || window.endTime <= window.startTime ||
      window.endTime - window.startTime > 30 * 60_000) throw new Error('CloudWatch correlation window is invalid or unbounded.');
  for (const requestId of requestIds) {
    const seen = new Set<string>();
    let cursor: string | undefined;
    const matched: Array<z.infer<typeof eventSchema>> = [];
    let pages = 0;
    do {
      pages += 1;
      if (pages > (options.maxPagesPerRequest ?? 60)) throw new Error('CloudWatch pagination exceeded the per-request limit.');
      if (cursor && seen.has(cursor)) throw new Error('CloudWatch pagination token repeated.');
      if (cursor) seen.add(cursor);
      const page = await source.page(requestId, cursor, window);
      for (const item of page.events) {
        if (!Number.isInteger(item.timestamp) || item.timestamp! < window.startTime || item.timestamp! > window.endTime) continue;
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
  attempts?: number; maxPagesPerGroup?: number; sleep?: (milliseconds: number) => Promise<void>;
} = {}) => ({
  observe: async (requestIds: string[], window: CorrelationWindow) => {
    const observedTokens = new Map<string, Set<string>>();
    const source: CorrelationSource = {
      page: async (requestId, nextToken, boundedWindow) => {
        if (!logGroupNames.length) throw new Error('CloudWatch log groups are required.');
        const cursorSchema = z.strictObject({ group: z.number().int().nonnegative(), page: z.number().int().nonnegative(), token: z.string().optional() });
        const cursor = nextToken ? cursorSchema.parse(JSON.parse(Buffer.from(nextToken, 'base64url').toString('utf8'))) : { group: 0, page: 0 };
        if (cursor.page >= (options.maxPagesPerGroup ?? 20)) throw new Error('CloudWatch pagination exceeded the per-group limit.');
        const logGroupName = logGroupNames[cursor.group];
        if (!logGroupName) throw new Error('CloudWatch correlation cursor is outside the log-group allowlist.');
        const tokenKey = `${requestId}\0${cursor.group}`;
        if (cursor.page === 0 && cursor.token === undefined) observedTokens.delete(tokenKey);
        const page = await client.send(new FilterLogEventsCommand({ logGroupName, filterPattern: `{ $.requestId = "${requestId}" }`,
          startTime: boundedWindow.startTime, endTime: boundedWindow.endTime,
          ...(cursor.token ? { nextToken: cursor.token } : {}) }));
        const seen = observedTokens.get(tokenKey) ?? new Set<string>();
        if (page.nextToken && seen.has(page.nextToken)) throw new Error('CloudWatch pagination token repeated.');
        if (page.nextToken) seen.add(page.nextToken);
        observedTokens.set(tokenKey, seen);
        const next = page.nextToken ? { group: cursor.group, page: cursor.page + 1, token: page.nextToken } :
          cursor.group + 1 < logGroupNames.length ? { group: cursor.group + 1, page: 0 } : undefined;
        return { events: (page.events ?? []).map(({ message, timestamp }) => ({ ...(message ? { message } : {}), ...(timestamp === undefined ? {} : { timestamp }) })),
          ...(next ? { nextToken: Buffer.from(JSON.stringify(next)).toString('base64url') } : {}) };
      },
    };
    const attempts = options.attempts ?? 6;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await correlateRequestLogs(requestIds, source, window, { maxPagesPerRequest: (options.maxPagesPerGroup ?? 20) * logGroupNames.length }); }
      catch (error) {
        if (error instanceof Error && /pagination|window|request IDs?/i.test(error.message)) throw error;
        if (attempt === attempts) throw error;
        await (options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(2_000);
      }
    }
    throw new Error('CloudWatch correlation exhausted its bounded retry window.');
  },
});
