import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { AppError } from './errors.js';
import { readActor } from './identity.js';
import { writeCompletionLog } from './logging.js';
import type { Actor } from './types.js';

const MAX_BODY_BYTES = 16 * 1_024;
const emptyObjectSchema = z.strictObject({});
const noBodySchema = z.undefined();

export type HttpRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  actor: Actor;
  requestId: string;
};

export type HttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type HttpApiEvent = {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string>;
  requestContext: {
    requestId: string;
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
    http: { method: string };
  };
  body?: string;
  isBase64Encoded?: boolean;
};

export const respond = (status: number, data: unknown, requestId: string): HttpResponse => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Request-Id': requestId,
  },
  body: JSON.stringify(data),
});

export const respondError = (error: unknown, requestId: string): HttpResponse => {
  const safeError = error instanceof AppError
    ? error
    : new AppError(500, 'INTERNAL_ERROR', 'Something went wrong.');
  return respond(safeError.status, {
    error: {
      code: safeError.code,
      message: safeError.message,
      requestId,
      ...(safeError.fieldErrors === undefined ? {} : { fieldErrors: safeError.fieldErrors }),
    },
  }, requestId);
};

export const validate = <T>(schema: z.ZodType<T>, value: unknown, rootField = 'request'): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const fieldErrors: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const fields = issue.code === 'unrecognized_keys'
      ? issue.keys
      : [issue.path.length === 0 ? rootField : String(issue.path[0])];
    for (const field of fields) {
      (fieldErrors[field] ??= []).push(issue.message);
    }
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'The request is invalid.', fieldErrors);
};

export const validateNoQuery = (query: Record<string, string>): void => {
  validate(emptyObjectSchema, query);
};

export const validateNoBody = (body: unknown): void => {
  validate(noBodySchema, body);
};

export const routeNotFound = (requestId: string): HttpResponse =>
  respondError(new AppError(404, 'NOT_FOUND', 'Route not found.'), requestId);

export const methodNotAllowed = (requestId: string): HttpResponse =>
  respondError(new AppError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.'), requestId);

export const withErrorResponse = async (
  requestId: string,
  run: () => Promise<HttpResponse>,
): Promise<HttpResponse> => {
  try {
    return await run();
  } catch (error) {
    return respondError(error, requestId);
  }
};

type LambdaHandlerOptions<Service> = {
  loadService: () => Promise<Service>;
  route: (request: HttpRequest, service: Service) => Promise<HttpResponse>;
  now?: () => number;
  writeLog?: (line: string) => void;
};

export const createLambdaHandler = <Service>({
  loadService,
  route,
  now = () => performance.now(),
  writeLog,
}: LambdaHandlerOptions<Service>) => async (event: HttpApiEvent): Promise<HttpResponse> => {
  const startedAt = now();
  const requestId = nonEmpty(event.requestContext.requestId) ? event.requestContext.requestId : 'unknown-request';
  let response: HttpResponse;

  try {
    const body = readBody(event);
    const actor = readActor(event);
    const query = readQuery(event);
    const service = await loadService();
    response = await route({
      method: event.requestContext.http.method.toUpperCase(),
      path: event.rawPath,
      query,
      body,
      actor,
      requestId,
    }, service);
  } catch (error) {
    response = respondError(error, requestId);
  }

  try {
    writeCompletionLog({
      requestId,
      operation: safeOperation(event.routeKey),
      status: response.statusCode,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
      errorCode: responseErrorCode(response),
    }, writeLog);
  } catch {
    // Logging must not replace the safe HTTP response.
  }

  return response;
};

const readBody = (event: HttpApiEvent): unknown => {
  if (event.body === undefined) return undefined;

  const bytes = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }

  const contentType = header(event.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The request body must be JSON.', {
      body: ['Content-Type must be application/json.'],
    });
  }

  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'The request body contains malformed JSON.', {
      body: ['The request body contains malformed JSON.'],
    });
  }
};

const readQuery = (event: HttpApiEvent): Record<string, string> => {
  const seen = new Set<string>();
  for (const [key] of new URLSearchParams(event.rawQueryString)) {
    if (seen.has(key)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'The request query is invalid.', {
        [key]: ['Query parameters must not be repeated.'],
      });
    }
    seen.add(key);
  }
  return { ...event.queryStringParameters };
};

const header = (headers: Record<string, string | undefined>, name: string): string | undefined => {
  const target = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
};

const safeOperation = (routeKey: string): string => {
  if (/^(?:GET \/api\/(?:me|clinicians|availability|appointments)|POST \/api\/(?:availability|appointments)|GET \/api\/clinicians\/\{id\}(?:\/slots)?|POST \/api\/(?:availability\/\{id\}\/withdraw|appointments\/\{id\}\/cancel))$/.test(routeKey)) {
    return routeKey;
  }

  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const dynamicRoutes: Array<[RegExp, string]> = [
    [new RegExp(`^GET /api/clinicians/${uuid}$`, 'i'), 'GET /api/clinicians/{id}'],
    [new RegExp(`^GET /api/clinicians/${uuid}/slots$`, 'i'), 'GET /api/clinicians/{id}/slots'],
    [new RegExp(`^POST /api/availability/${uuid}/withdraw$`, 'i'), 'POST /api/availability/{id}/withdraw'],
    [new RegExp(`^POST /api/appointments/${uuid}/cancel$`, 'i'), 'POST /api/appointments/{id}/cancel'],
  ];
  for (const [pattern, operation] of dynamicRoutes) {
    if (pattern.test(routeKey)) return operation;
  }
  return 'unknown';
};

const responseErrorCode = (response: HttpResponse): string | null => {
  if (response.statusCode < 400) return null;
  try {
    const data = JSON.parse(response.body) as { error?: { code?: unknown } };
    return typeof data.error?.code === 'string' ? data.error.code : 'INTERNAL_ERROR';
  } catch {
    return 'INTERNAL_ERROR';
  }
};

const nonEmpty = (value: string): boolean => value.trim().length > 0;
