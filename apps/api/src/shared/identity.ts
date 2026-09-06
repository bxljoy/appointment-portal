import type { HttpApiEvent } from './http.js';
import type { Actor } from './types.js';
import { AppError } from './errors.js';

export const readActor = (event: HttpApiEvent): Actor => {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || sub.trim().length === 0) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }
  return { sub };
};
