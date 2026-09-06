import { Temporal } from '@js-temporal/polyfill';
import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Me, Slot, WindowQuery } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { formatAppointmentTime } from '../../lib/time';
import { useClinician } from '../clinicians/queries';
import { useOwnSlots, useWithdrawSlot } from './queries';
import { SlotForm } from './slot-form';

const canWithdraw = (slot: Slot) => slot.status === 'open' && !slot.isBooked && Temporal.Instant.compare(Temporal.Instant.from(slot.startAt), Temporal.Now.instant()) > 0;
const mergeSlots = (current: Slot[], incoming: Slot[]) => [...new Map([...current, ...incoming].map((slot) => [slot.id, slot])).values()].sort((left, right) => left.startAt.localeCompare(right.startAt));

export const availabilityWeekForDate = (date: string, timezone: string): WindowQuery | undefined => {
  try {
    const startDate = Temporal.PlainDate.from(date);
    if (startDate.toString() !== date) return undefined;
    const from = startDate.toPlainDateTime('00:00').toZonedDateTime(timezone, { disambiguation: 'reject' }).toInstant();
    const to = startDate.add({ days: 7 }).toPlainDateTime('00:00').toZonedDateTime(timezone, { disambiguation: 'reject' }).toInstant();
    return Temporal.Instant.compare(from, to) < 0 ? { from: from.toString(), to: to.toString(), limit: 100 } : undefined;
  } catch {
    return undefined;
  }
};

function AgendaRow({ slot, timezone, onWithdraw }: { slot: Slot; timezone: string; onWithdraw(slot: Slot): void }) {
  const withdrawal = useWithdrawSlot();
  const status = slot.status === 'withdrawn' ? 'Withdrawn' : slot.isBooked ? 'Open — booked' : 'Open — available to patients';
  const withdraw = async () => {
    try {
      onWithdraw(await withdrawal.mutateAsync(slot.id));
    } catch {
      // The server remains authoritative and the mutation exposes the retryable error.
    }
  };
  return <li className="flex flex-col gap-3 rounded-md border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{formatAppointmentTime(slot.startAt, timezone)} – {formatAppointmentTime(slot.endAt, timezone)}</p><p className="mt-1 text-sm text-muted-foreground">{status}</p>{withdrawal.isError && <p role="alert" className="mt-2 error-message">{withdrawal.error instanceof Error ? withdrawal.error.message : 'We could not withdraw this slot.'}</p>}</div>{canWithdraw(slot) && <Button variant="outline" onClick={() => void withdraw()} disabled={withdrawal.isPending}>{withdrawal.isPending ? 'Withdrawing…' : 'Withdraw slot'}</Button>}</li>;
}

export function ClinicianAvailabilityPage() {
  const me = useOutletContext<Me>();
  const profile = useClinician(me.id);
  const timezone = profile.data?.timezone;
  const defaultDate = timezone ? Temporal.Now.zonedDateTimeISO(timezone).toPlainDate().toString() : '';
  const [selectedDate, setSelectedDate] = useState('');
  const date = selectedDate || defaultDate;
  const window = useMemo(() => timezone ? availabilityWeekForDate(date, timezone) : undefined, [date, timezone]);
  const scope = window ? `${window.from}:${window.to}` : '';
  const [cursor, setCursor] = useState<{ scope: string; value?: string }>({ scope: '' });
  const page = useOwnSlots(window && { ...window, cursor: cursor.scope === scope ? cursor.value : undefined });
  const [agenda, setAgenda] = useState<{ scope: string; items: Slot[]; nextCursor: string | null }>();
  useEffect(() => {
    if (!page.data || !scope) return;
    setAgenda((current) => ({ scope, items: mergeSlots(current?.scope === scope ? current.items : [], page.data.items), nextCursor: page.data.nextCursor }));
  }, [page.data, scope]);
  const agendaItems = agenda?.scope === scope ? agenda.items : [];
  const nextCursor = agenda?.scope === scope ? agenda.nextCursor : null;
  const updateAgendaSlot = (slot: Slot) => setAgenda((current) => current?.scope === scope ? { ...current, items: mergeSlots(current.items, [slot]) } : current);
  const createdInWindow = (slot: Slot) => window && Temporal.Instant.compare(Temporal.Instant.from(slot.startAt), Temporal.Instant.from(window.from)) >= 0 && Temporal.Instant.compare(Temporal.Instant.from(slot.startAt), Temporal.Instant.from(window.to)) < 0;
  return <section aria-labelledby="availability-title" className="space-y-8"><header><p className="eyebrow">Your schedule</p><h1 id="availability-title">Your availability</h1><p className="mt-3 text-muted-foreground">Publish one appointment time at a time. Entries are interpreted in your profile timezone.</p>{timezone && <p className="mt-2 text-sm">Timezone: {timezone}.</p>}</header>
    {profile.isPending && <p role="status" aria-busy="true">Loading your profile timezone</p>}{profile.isError && <p role="alert" className="error-message">We could not load your profile timezone. Refresh the page before publishing a slot.</p>}
    {timezone && <><section aria-labelledby="publish-title"><h2 id="publish-title" className="text-xl">Publish a slot</h2><div className="mt-4"><SlotForm timezone={timezone} onCreated={(slot) => { if (createdInWindow(slot)) updateAgendaSlot(slot); }} /></div></section>
      <section aria-labelledby="agenda-title"><h2 id="agenda-title" className="text-xl">Your slot agenda</h2><div className="mt-4 max-w-sm"><label htmlFor="availability-week" className="block text-sm font-semibold">Availability week starting</label><input id="availability-week" type="date" value={date} onChange={(event) => { setSelectedDate(event.target.value); setCursor({ scope: '' }); }} className="mt-2 min-h-11 w-full rounded-md border bg-surface px-3" /><p className="mt-2 text-sm text-muted-foreground">Uses your profile timezone: {timezone}.</p></div>{!window && <p role="alert" className="mt-4 error-message">Choose a valid availability week start date.</p>}{window && page.isPending && agendaItems.length === 0 && <p role="status" aria-busy="true" className="mt-4">Loading your slots</p>}{window && page.isError && <div role="alert" className="mt-4 error-message"><p>{page.error instanceof Error ? page.error.message : 'We could not load your slots.'}</p><Button onClick={() => void page.refetch()}>Try again</Button></div>}{window && (agendaItems.length ? <ul role="list" className="mt-4 space-y-3">{agendaItems.map((slot) => <AgendaRow key={slot.id} slot={slot} timezone={timezone} onWithdraw={updateAgendaSlot} />)}</ul> : page.data && <p role="status" className="mt-4 rounded-md border bg-surface p-5">You have no slots in this week.</p>)}{nextCursor && <Button className="mt-4" variant="outline" onClick={() => setCursor({ scope, value: nextCursor })} disabled={page.isFetching}>{page.isFetching ? 'Loading more availability…' : 'Load more availability'}</Button>}</section></>}
  </section>;
}
