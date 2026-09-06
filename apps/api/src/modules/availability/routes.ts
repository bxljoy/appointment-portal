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

const idSchema = z.uuid();

export const handleAvailability = async (
  request: HttpRequest,
  service: AvailabilityService,
): Promise<HttpResponse> => withErrorResponse(request.requestId, async () => {
  const publicMatch = /^\/api\/clinicians\/([^/]+)\/slots$/.exec(request.path);
  if (publicMatch) {
    if (request.method !== 'GET') return methodNotAllowed(request.requestId);
    validateNoBody(request.body);
    const clinicianId = validate(idSchema, publicMatch[1], 'id');
    const query = validate(WindowQuerySchema, request.query);
    return respond(200, await service.listPublic(request.actor, clinicianId, query), request.requestId);
  }

  if (request.path === '/api/availability') {
    if (request.method === 'GET') {
      validateNoBody(request.body);
      const query = validate(WindowQuerySchema, request.query);
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
