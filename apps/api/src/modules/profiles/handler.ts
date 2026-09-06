import { getApplicationPool } from '../../shared/database.js';
import { createLambdaHandler } from '../../shared/http.js';
import type { ProfilesService } from '../../shared/types.js';
import { handleProfiles } from './routes.js';
import { makeProfilesService } from './service.js';

let servicePromise: Promise<ProfilesService> | undefined;

const loadService = (): Promise<ProfilesService> => {
  if (!servicePromise) {
    servicePromise = getApplicationPool()
      .then((pool) => makeProfilesService({ pool, clock: () => new Date() }))
      .catch((error: unknown) => {
        servicePromise = undefined;
        throw error;
      });
  }
  return servicePromise;
};

export const handler = createLambdaHandler({ loadService, route: handleProfiles });
