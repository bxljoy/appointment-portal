import {
  BookInputSchema,
  CancelInputSchema,
  PageQuerySchema,
  decodeCursor,
  encodeCursor,
} from '@portal/contracts';

import { inTransaction } from '../../shared/database.js';
import { AppError } from '../../shared/errors.js';
import type { Actor, AppointmentsService, ServicesDeps } from '../../shared/types.js';
import { hasBookedAppointment, lockSlot, withdrawSlot } from '../availability/repository.js';
import { ensureUser } from '../profiles/repository.js';
import {
  cancelAppointment,
  findAppointment,
  findAppointmentSlotId,
  findAppointments,
  insertAppointment,
  lockAppointment,
} from './repository.js';

export const makeAppointmentsService = (deps: ServicesDeps): AppointmentsService => ({
  async list(actor, query) {
    const user = await ensureUser(deps.pool, actor);
    const pageQuery = PageQuerySchema.safeParse(query);
    if (!pageQuery.success) {
      throw validationError('query', 'The appointment page is invalid.');
    }
    const cursor = parseCursor(pageQuery.data.cursor);
    const appointments = await findAppointments(deps.pool, user, cursor, pageQuery.data.limit + 1);
    const hasNextPage = appointments.length > pageQuery.data.limit;
    const items = hasNextPage ? appointments.slice(0, pageQuery.data.limit) : appointments;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasNextPage && last ? encodeCursor({ sortValue: last.startAt, id: last.id }) : null,
    };
  },

  async book(actor, input) {
    const patient = await ensurePatient(deps, actor);
    const bookInput = BookInputSchema.safeParse(input);
    if (!bookInput.success) {
      throw validationError('slotId', 'A valid slot ID is required.');
    }

    try {
      return await inTransaction(deps.pool, async (client) => {
        const slot = await lockSlot(client, bookInput.data.slotId);
        if (!slot) {
          throw new AppError(404, 'NOT_FOUND', 'Availability slot not found.');
        }
        const now = deps.clock();
        if (slot.status !== 'open' || new Date(slot.startAt).getTime() <= now.getTime()) {
          throw slotUnavailable();
        }
        if (await hasBookedAppointment(client, slot.id)) {
          throw slotUnavailable();
        }
        const appointmentId = await insertAppointment(client, slot.id, patient.id);
        const appointment = await findAppointment(client, appointmentId);
        if (!appointment) throw new Error('Created appointment could not be read');
        return appointment;
      });
    } catch (error) {
      if (isActiveBookingConflict(error)) {
        throw slotUnavailable();
      }
      throw error;
    }
  },

  async cancel(actor, appointmentId, input) {
    const user = await ensureUser(deps.pool, actor);
    const cancelInput = CancelInputSchema.safeParse(input);
    if (!cancelInput.success) {
      throw validationError('withdrawSlot', 'The cancellation request is invalid.');
    }
    return inTransaction(deps.pool, async (client) => {
      const slotId = await findAppointmentSlotId(client, appointmentId);
      if (!slotId) throw appointmentNotFound();

      const slot = await lockSlot(client, slotId);
      const appointment = await lockAppointment(client, appointmentId);
      if (!slot || !appointment || appointment.slotId !== slot.id || !canAccess(user, appointment.patientId, slot.clinicianId)) {
        throw appointmentNotFound();
      }
      if (user.role === 'patient' && cancelInput.data.withdrawSlot) {
        throw new AppError(403, 'FORBIDDEN', 'Patients cannot withdraw availability slots.');
      }

      if (appointment.status === 'cancelled') {
        return requireAppointment(await findAppointment(client, appointment.id));
      }

      const now = deps.clock();
      if (new Date(slot.startAt).getTime() <= now.getTime()) {
        throw new AppError(409, 'APPOINTMENT_STARTED', 'Started appointments cannot be cancelled.');
      }

      await cancelAppointment(client, appointment.id, now, user.id);
      if (cancelInput.data.withdrawSlot) {
        await withdrawSlot(client, slot.id);
      }
      return requireAppointment(await findAppointment(client, appointment.id));
    });
  },
});

const ensurePatient = async (deps: ServicesDeps, actor: Actor) => {
  const user = await ensureUser(deps.pool, actor);
  if (user.role !== 'patient') {
    throw new AppError(403, 'FORBIDDEN', 'Patient access is required.');
  }
  return user;
};

const canAccess = (
  user: { id: string; role: 'patient' | 'clinician' },
  patientId: string,
  clinicianId: string,
): boolean => (user.role === 'patient' ? user.id === patientId : user.id === clinicianId);

const parseCursor = (raw: string | undefined): { sortValue: string; id: string } | undefined => {
  if (!raw) return undefined;
  try {
    return decodeCursor(raw, 'time');
  } catch {
    throw validationError('cursor', 'The cursor is invalid.');
  }
};

const isActiveBookingConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === '23505' &&
  'constraint' in error &&
  error.constraint === 'one_active_booking_per_slot';

const slotUnavailable = () =>
  new AppError(409, 'SLOT_UNAVAILABLE', 'This availability slot is no longer available.');

const appointmentNotFound = () => new AppError(404, 'NOT_FOUND', 'Appointment not found.');

const requireAppointment = <T>(appointment: T | undefined): T => {
  if (!appointment) throw new Error('Appointment could not be read');
  return appointment;
};

const validationError = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_ERROR', message, { [field]: [message] });
