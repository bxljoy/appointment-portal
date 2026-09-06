import {
  CreateSlotInputSchema,
  WindowQuerySchema,
  decodeCursor,
  encodeCursor,
  type CreateSlotInput,
  type WindowQuery,
} from '@portal/contracts';

import { AppError } from '../../shared/errors.js';
import type { Actor, AvailabilityService, ServicesDeps } from '../../shared/types.js';
import { ensureUser } from '../profiles/repository.js';
import { findOwnSlots, findPublicSlots, insertSlot, lockSlot, withdrawSlot } from './repository.js';

export const makeAvailabilityService = (deps: ServicesDeps): AvailabilityService => ({
  async listPublic(actor, clinicianId, query) {
    await ensureUser(deps.pool, actor);
    const window = validateWindow(query);
    const cursor = parseCursor(window.cursor);
    return page(
      await findPublicSlots(deps.pool, clinicianId, deps.clock(), window, cursor, window.limit + 1),
      window.limit,
    );
  },

  async listOwn(actor, query) {
    const clinician = await ensureClinician(deps, actor);
    const window = validateWindow(query);
    const cursor = parseCursor(window.cursor);
    return page(
      await findOwnSlots(deps.pool, clinician.id, window, cursor, window.limit + 1),
      window.limit,
    );
  },

  async create(actor, input) {
    const clinician = await ensureClinician(deps, actor);
    const startAt = validateStartAt(input, deps.clock);
    try {
      return await insertSlot(deps.pool, clinician.id, startAt);
    } catch (error) {
      if (postgresCode(error) === '23P01') {
        throw new AppError(409, 'SLOT_OVERLAP', 'This availability slot overlaps an existing open slot.');
      }
      throw error;
    }
  },

  async withdraw(actor, slotId) {
    const clinician = await ensureClinician(deps, actor);
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const slot = await lockSlot(client, slotId);
      if (!slot || slot.clinicianId !== clinician.id) {
        throw new AppError(404, 'NOT_FOUND', 'Availability slot not found.');
      }
      if (slot.status === 'withdrawn') {
        await client.query('COMMIT');
        return slot;
      }
      if (new Date(slot.startAt).getTime() <= deps.clock().getTime()) {
        throw new AppError(409, 'SLOT_UNAVAILABLE', 'Only future availability slots can be withdrawn.');
      }
      if (slot.isBooked) {
        throw new AppError(409, 'SLOT_UNAVAILABLE', 'Booked availability slots cannot be withdrawn.');
      }
      const withdrawn = await withdrawSlot(client, slot.id);
      await client.query('COMMIT');
      return withdrawn;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
});

const ensureClinician = async (deps: ServicesDeps, actor: Actor) => {
  const user = await ensureUser(deps.pool, actor);
  if (user.role !== 'clinician') {
    throw new AppError(403, 'FORBIDDEN', 'Clinician access is required.');
  }
  return user;
};

const validateStartAt = (input: CreateSlotInput, clock: () => Date): Date => {
  const parsed = CreateSlotInputSchema.safeParse(input);
  if (!parsed.success) {
    throw validationError('startAt', 'startAt must be an offset-qualified ISO timestamp.');
  }
  const startAt = new Date(parsed.data.startAt);
  if (startAt.getUTCSeconds() !== 0 || startAt.getUTCMilliseconds() !== 0) {
    throw validationError('startAt', 'Availability slots must start on a whole minute.');
  }
  if (startAt.getTime() <= clock().getTime()) {
    throw validationError('startAt', 'Availability slots must start in the future.');
  }
  return startAt;
};

const validateWindow = (query: WindowQuery) => {
  const parsed = WindowQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw validationError('window', 'The availability window is invalid.');
  }
  return parsed.data;
};

const parseCursor = (raw: string | undefined): { sortValue: string; id: string } | undefined => {
  if (!raw) {
    return undefined;
  }
  try {
    return decodeCursor(raw, 'time');
  } catch {
    throw validationError('cursor', 'The cursor is invalid.');
  }
};

const page = <T extends { startAt: string; id: string }>(items: T[], limit: number) => {
  const hasNextPage = items.length > limit;
  const pageItems = hasNextPage ? items.slice(0, limit) : items;
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor: hasNextPage && last ? encodeCursor({ sortValue: last.startAt, id: last.id }) : null,
  };
};

const validationError = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_ERROR', message, { [field]: [message] });

const postgresCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
