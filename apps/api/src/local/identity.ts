import type { IncomingHttpHeaders } from 'node:http';

import { AppError } from '../shared/errors.js';
import type { Actor } from '../shared/types.js';

const localActorSubs = new Map<string, string>([
  ['patient-a', 'patient-a'],
  ['patient-b', 'patient-b'],
  ['clinician-a', 'clinician-a'],
  ['clinician-b', 'clinician-b'],
]);
const localActorHeader = 'X-Local-Actor';

export const assertLocalAuthEnabled = (env: NodeJS.ProcessEnv = process.env): void => {
  if (env.PORTAL_LOCAL_AUTH !== '1' || env.NODE_ENV === 'production') {
    throw new Error('Local authentication requires PORTAL_LOCAL_AUTH=1 outside production.');
  }
};

export const readLocalActor = (headers: IncomingHttpHeaders): Actor => {
  const value = headers[localActorHeader.toLowerCase()];
  const sub = typeof value === 'string' ? localActorSubs.get(value) : undefined;
  if (sub === undefined) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }
  return { sub };
};
