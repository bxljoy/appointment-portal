import type {
  Appointment,
  BookInput,
  CancelInput,
  Clinician,
  CreateSlotInput,
  Me,
  Page,
  PageQuery,
  Slot,
  WindowQuery,
} from '@portal/contracts';
import type { Pool } from 'pg';

export type Actor = { sub: string };

export type Clock = () => Date;

export type ServicesDeps = {
  pool: Pool;
  clock: Clock;
};

export type ProfilesService = {
  getMe(actor: Actor): Promise<Me>;
  listClinicians(actor: Actor, query: PageQuery): Promise<Page<Clinician>>;
  getClinician(actor: Actor, id: string): Promise<Clinician>;
};

export type AvailabilityService = {
  listPublic(actor: Actor, clinicianId: string, query: WindowQuery): Promise<Page<Slot>>;
  listOwn(actor: Actor, query: WindowQuery): Promise<Page<Slot>>;
  create(actor: Actor, input: CreateSlotInput): Promise<Slot>;
  withdraw(actor: Actor, slotId: string): Promise<Slot>;
};

export type AppointmentsService = {
  list(actor: Actor, query: PageQuery): Promise<Page<Appointment>>;
  book(actor: Actor, input: BookInput): Promise<Appointment>;
  cancel(actor: Actor, appointmentId: string, input: CancelInput): Promise<Appointment>;
};
