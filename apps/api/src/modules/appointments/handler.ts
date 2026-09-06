import { getApplicationPool } from '../../shared/database.js';
import { createLambdaHandler } from '../../shared/http.js';
import type { AppointmentsService } from '../../shared/types.js';
import { handleAppointments } from './routes.js';
import { makeAppointmentsService } from './service.js';

let servicePromise: Promise<AppointmentsService> | undefined;

const loadService = (): Promise<AppointmentsService> => {
  if (!servicePromise) {
    servicePromise = getApplicationPool()
      .then((pool) => makeAppointmentsService({ pool, clock: () => new Date() }))
      .catch((error: unknown) => {
        servicePromise = undefined;
        throw error;
      });
  }
  return servicePromise;
};

export const handler = createLambdaHandler({ loadService, route: handleAppointments });
