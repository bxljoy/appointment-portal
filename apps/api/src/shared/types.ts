import type { Clinician, Me, Page, PageQuery } from '@portal/contracts';
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
