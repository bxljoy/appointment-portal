import { getApplicationPool } from '../../shared/database.js';
import { createLambdaHandler } from '../../shared/http.js';
import type { AvailabilityService, Clock } from '../../shared/types.js';
import { handleAvailability } from './routes.js';
import { makeAvailabilityService } from './service.js';

let servicePromise: Promise<AvailabilityService> | undefined;
const trustedServerClock: Clock = () => new Date();

const loadService = (): Promise<AvailabilityService> => {
  if (!servicePromise) {
    servicePromise = getApplicationPool()
      .then((pool) => makeAvailabilityService({ pool, clock: trustedServerClock }))
      .catch((error: unknown) => {
        servicePromise = undefined;
        throw error;
      });
  }
  return servicePromise;
};

export const handler = createLambdaHandler({
  loadService,
  route: (request, service) => handleAvailability(request, service, trustedServerClock),
});
