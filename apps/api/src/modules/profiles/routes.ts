import { PageQuerySchema } from '@portal/contracts';
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
import type { ProfilesService } from '../../shared/types.js';

const idSchema = z.uuid();

export const ownsProfilesPath = (path: string): boolean =>
  path === '/api/me' || path === '/api/clinicians' || /^\/api\/clinicians\/[^/]+$/.test(path);

export const handleProfiles = async (
  request: HttpRequest,
  service: ProfilesService,
): Promise<HttpResponse> => withErrorResponse(request.requestId, async () => {
  if (request.path === '/api/me') {
    if (request.method !== 'GET') return methodNotAllowed(request.requestId);
    validateNoQuery(request.query);
    validateNoBody(request.body);
    return respond(200, await service.getMe(request.actor), request.requestId);
  }

  if (request.path === '/api/clinicians') {
    if (request.method !== 'GET') return methodNotAllowed(request.requestId);
    validateNoBody(request.body);
    const query = validate(PageQuerySchema, request.query);
    return respond(200, await service.listClinicians(request.actor, query), request.requestId);
  }

  const clinicianMatch = /^\/api\/clinicians\/([^/]+)$/.exec(request.path);
  if (clinicianMatch) {
    if (request.method !== 'GET') return methodNotAllowed(request.requestId);
    validateNoQuery(request.query);
    validateNoBody(request.body);
    const id = validate(idSchema, clinicianMatch[1], 'id');
    return respond(200, await service.getClinician(request.actor, id), request.requestId);
  }

  return routeNotFound(request.requestId);
});
