import { BookInputSchema, CancelInputSchema, PageQuerySchema } from '@portal/contracts';
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
import type { AppointmentsService } from '../../shared/types.js';

const idSchema = z.uuid();

export const handleAppointments = async (
  request: HttpRequest,
  service: AppointmentsService,
): Promise<HttpResponse> => withErrorResponse(request.requestId, async () => {
  if (request.path === '/api/appointments') {
    if (request.method === 'GET') {
      validateNoBody(request.body);
      const query = validate(PageQuerySchema, request.query);
      return respond(200, await service.list(request.actor, query), request.requestId);
    }
    if (request.method === 'POST') {
      validateNoQuery(request.query);
      const input = validate(BookInputSchema, request.body);
      return respond(201, await service.book(request.actor, input), request.requestId);
    }
    return methodNotAllowed(request.requestId);
  }

  const cancelMatch = /^\/api\/appointments\/([^/]+)\/cancel$/.exec(request.path);
  if (cancelMatch) {
    if (request.method !== 'POST') return methodNotAllowed(request.requestId);
    validateNoQuery(request.query);
    const appointmentId = validate(idSchema, cancelMatch[1], 'id');
    const input = validate(CancelInputSchema, request.body);
    return respond(200, await service.cancel(request.actor, appointmentId, input), request.requestId);
  }

  return routeNotFound(request.requestId);
});
