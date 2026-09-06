import { decodeCursor, encodeCursor } from '@portal/contracts';

import { AppError } from '../../shared/errors.js';
import type { ProfilesService, ServicesDeps } from '../../shared/types.js';
import { ensureUser, findClinicianById, findClinicians } from './repository.js';

export const makeProfilesService = (deps: ServicesDeps): ProfilesService => ({
  getMe: (actor) => ensureUser(deps.pool, actor),

  async listClinicians(actor, query) {
    await ensureUser(deps.pool, actor);
    const cursor = query.cursor ? parseCursor(query.cursor) : undefined;
    const clinicians = await findClinicians(deps.pool, cursor, query.limit + 1);
    const hasNextPage = clinicians.length > query.limit;
    const items = hasNextPage ? clinicians.slice(0, query.limit) : clinicians;
    const last = items.at(-1);

    return {
      items,
      nextCursor: hasNextPage && last ? encodeCursor({ sortValue: last.displayName, id: last.id }) : null,
    };
  },

  async getClinician(actor, id) {
    await ensureUser(deps.pool, actor);
    const clinician = await findClinicianById(deps.pool, id);
    if (!clinician) {
      throw new AppError(404, 'NOT_FOUND', 'Clinician not found.');
    }
    return clinician;
  },
});

const parseCursor = (raw: string): { sortValue: string; id: string } => {
  try {
    return decodeCursor(raw, 'name');
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'The cursor is invalid.', {
      cursor: ['The cursor is invalid.'],
    });
  }
};
