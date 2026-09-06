import { Temporal } from '@js-temporal/polyfill';
import { useOutletContext } from 'react-router-dom';
import type { Me, Slot } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { formatAppointmentTime } from '../../lib/time';
import { useClinician } from '../clinicians/queries';
import { useOwnSlots, useWithdrawSlot } from './queries';
import { SlotForm } from './slot-form';

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const canWithdraw = (slot: Slot) => slot.status === 'open' && !slot.isBooked && Temporal.Instant.compare(Temporal.Instant.from(slot.startAt), Temporal.Now.instant()) > 0;

function AgendaRow({ slot, timezone }: { slot: Slot; timezone: string }) {
  const withdrawal = useWithdrawSlot();
  const status = slot.status === 'withdrawn' ? 'Withdrawn' : slot.isBooked ? 'Open — booked' : 'Open — available to patients';
  return <li className="flex flex-col gap-3 rounded-md border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{formatAppointmentTime(slot.startAt, timezone)} – {formatAppointmentTime(slot.endAt, timezone)}</p><p className="mt-1 text-sm text-muted-foreground">{status}</p>{withdrawal.isError && <p role="alert" className="mt-2 error-message">{withdrawal.error instanceof Error ? withdrawal.error.message : 'We could not withdraw this slot.'}</p>}</div>{canWithdraw(slot) && <Button variant="outline" onClick={() => withdrawal.mutate(slot.id)} disabled={withdrawal.isPending}>{withdrawal.isPending ? 'Withdrawing…' : 'Withdraw slot'}</Button>}</li>;
}

export function ClinicianAvailabilityPage() {
  const me = useOutletContext<Me>();
  const profile = useClinician(me.id);
  const slots = useOwnSlots();
  const timezone = profile.data?.timezone;
  const displayTimezone = timezone ?? localTimezone();
  return <section aria-labelledby="availability-title" className="space-y-8"><header><p className="eyebrow">Your schedule</p><h1 id="availability-title">Your availability</h1><p className="mt-3 text-muted-foreground">Publish one appointment time at a time. Entries are interpreted in your profile timezone.</p>{timezone && <p className="mt-2 text-sm">Timezone: {timezone}.</p>}</header>
    {profile.isPending && <p role="status" aria-busy="true">Loading your profile timezone</p>}{profile.isError && <p role="alert" className="error-message">We could not load your profile timezone. Refresh the page before publishing a slot.</p>}
    {timezone && <section aria-labelledby="publish-title"><h2 id="publish-title" className="text-xl">Publish a slot</h2><div className="mt-4"><SlotForm timezone={timezone} /></div></section>}
    <section aria-labelledby="agenda-title"><h2 id="agenda-title" className="text-xl">Your slot agenda</h2>{slots.isPending && <p role="status" aria-busy="true" className="mt-4">Loading your slots</p>}{slots.isError && <div role="alert" className="error-message"><p>{slots.error instanceof Error ? slots.error.message : 'We could not load your slots.'}</p><Button onClick={() => void slots.refetch()}>Try again</Button></div>}{slots.data && (slots.data.items.length ? <ul role="list" className="mt-4 space-y-3">{slots.data.items.map((slot) => <AgendaRow key={slot.id} slot={slot} timezone={displayTimezone} />)}</ul> : <p role="status" className="mt-4 rounded-md border bg-surface p-5">You have no upcoming slots.</p>)}</section>
  </section>;
}
