import { CreateSlotInputSchema, WindowQuerySchema } from '@portal/contracts';
import { z } from 'zod';

import {
  methodNotAllowed,
  respond,
  routeNotFound,
  validate,
  validateNoBody,
  validateNoQuery,
  withErrorResponse,
  type HttpRequest,
  type HttpResponse,
} from '../../shared/http.js';
import type { AvailabilityService } from '../../shared/types.js';
import type { Clock } from '../../shared/types.js';

const idSchema = z.uuid();
const DEFAULT_WINDOW_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export const handleAvailability = async (
  request: HttpRequest,
  service: AvailabilityService,
  clock: Clock = () => new Date(),
): Promise<HttpResponse> => withErrorResponse(request.requestId, async () => {
  const publicMatch = /^\/api\/clinicians\/([^/]+)\/slots$/.exec(request.path);
  if (publicMatch) {
    if (request.method !== 'GET') return methodNotAllowed(request.requestId);
    validateNoBody(request.body);
    const clinicianId = validate(idSchema, publicMatch[1], 'id');
    const query = validate(WindowQuerySchema, withDefaultWindow(request.query, clock));
    return respond(200, await service.listPublic(request.actor, clinicianId, query), request.requestId);
  }

  if (request.path === '/api/availability') {
    if (request.method === 'GET') {
      validateNoBody(request.body);
      const query = validate(WindowQuerySchema, withDefaultWindow(request.query, clock));
      return respond(200, await service.listOwn(request.actor, query), request.requestId);
    }
    if (request.method === 'POST') {
      validateNoQuery(request.query);
      const input = validate(CreateSlotInputSchema, request.body);
      return respond(201, await service.create(request.actor, input), request.requestId);
    }
    return methodNotAllowed(request.requestId);
  }

  const withdrawMatch = /^\/api\/availability\/([^/]+)\/withdraw$/.exec(request.path);
  if (withdrawMatch) {
    if (request.method !== 'POST') return methodNotAllowed(request.requestId);
    validateNoQuery(request.query);
    validateNoBody(request.body);
    const slotId = validate(idSchema, withdrawMatch[1], 'id');
    return respond(200, await service.withdraw(request.actor, slotId), request.requestId);
  }

  return routeNotFound(request.requestId);
});

const withDefaultWindow = (query: Record<string, string>, clock: Clock): Record<string, string> => {
  if (Object.hasOwn(query, 'from') || Object.hasOwn(query, 'to')) return query;

  const from = clock();
  return {
    ...query,
    from: from.toISOString(),
    to: new Date(from.getTime() + DEFAULT_WINDOW_DURATION_MS).toISOString(),
  };
};
