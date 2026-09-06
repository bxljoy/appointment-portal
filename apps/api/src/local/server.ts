import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { Pool } from 'pg';

import { handleAppointments, ownsAppointmentsPath } from '../modules/appointments/routes.js';
import { makeAppointmentsService } from '../modules/appointments/service.js';
import { handleAvailability, ownsAvailabilityPath } from '../modules/availability/routes.js';
import { makeAvailabilityService } from '../modules/availability/service.js';
import { handleProfiles, ownsProfilesPath } from '../modules/profiles/routes.js';
import { makeProfilesService } from '../modules/profiles/service.js';
import {
  parseJsonBody,
  parseQuery,
  respondError,
  routeNotFound,
  type HttpRequest,
  type HttpResponse,
} from '../shared/http.js';
import { AppError } from '../shared/errors.js';
import type { AppointmentsService, AvailabilityService, ProfilesService } from '../shared/types.js';
import { assertLocalAuthEnabled, readLocalActor } from './identity.js';

type LocalServerOptions = {
  pool: Pool;
  port?: number;
};

type LocalServices = {
  profiles: ProfilesService;
  availability: AvailabilityService;
  appointments: AppointmentsService;
};

export type LocalServer = {
  baseUrl: string;
  close(): Promise<void>;
};

export const startLocalServer = async ({ pool, port = 3001 }: LocalServerOptions): Promise<LocalServer> => {
  assertLocalAuthEnabled();
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Local API port must be an integer between 0 and 65535.');
  }

  const clock = () => new Date();
  const services: LocalServices = {
    profiles: makeProfilesService({ pool, clock }),
    availability: makeAvailabilityService({ pool, clock }),
    appointments: makeAppointmentsService({ pool, clock }),
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, services);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error('Local API did not bind a TCP address.');
  }

  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      closePromise ??= closeServer(server, pool);
      return closePromise;
    },
  };
};

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  services: LocalServices,
): Promise<void> => {
  const requestId = randomUUID();
  let result: HttpResponse;
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = parseJsonBody(await readIncomingBody(request), requestHeaders(request));
    result = await route({
      method: (request.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: parseQuery(url.search.slice(1)),
      body,
      actor: readLocalActor(request.headers),
      requestId,
    }, services);
  } catch (error) {
    result = respondError(error, requestId);
  }
  writeResponse(response, result);
};

const route = async (request: HttpRequest, services: LocalServices): Promise<HttpResponse> => {
  if (ownsProfilesPath(request.path)) return handleProfiles(request, services.profiles);
  if (ownsAvailabilityPath(request.path)) return handleAvailability(request, services.availability);
  if (ownsAppointmentsPath(request.path)) return handleAppointments(request, services.appointments);
  return routeNotFound(request.requestId);
};

const readIncomingBody = async (request: IncomingMessage): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > 16 * 1_024) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
    }
    chunks.push(bytes);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
};

const requestHeaders = (request: IncomingMessage): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [
    name,
    Array.isArray(value) ? value.join(',') : value,
  ]));

const writeResponse = (response: ServerResponse, result: HttpResponse): void => {
  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
};

const closeServer = async (server: ReturnType<typeof createServer>, pool: Pool): Promise<void> => {
  try {
    await new Promise<void>((resolveClose, rejectClose) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  } finally {
    await pool.end();
  }
};

const runCli = async (): Promise<void> => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const port = Number(process.env.PORT ?? '3001');
  const localServer = await startLocalServer({ pool, port });
  process.stdout.write(`Local API listening at ${localServer.baseUrl}\n`);

  const shutdown = () => {
    void localServer.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
