import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { WindowQuery } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { BookingForm } from '../appointments/booking-form';
import { useClinician, useSlots } from './queries';

const viewerTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const formatDate = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};
const localParts = (date: Date, timezone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
const zonedMidnight = (date: string, timezone: string): Date | undefined => {
  if (!datePattern.test(date)) return undefined;
  const [year, month, day] = date.split('-').map(Number);
  const intended = Date.UTC(year, month - 1, day);
  const candidate = new Date(intended);
  const parts = localParts(candidate, timezone);
  const adjusted = new Date(intended - (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - intended));
  const verified = localParts(adjusted, timezone);
  return verified.year === year && verified.month === month && verified.day === day && verified.hour === 0 ? adjusted : undefined;
};
export const availabilityWindowForDate = (date: string, timezone: string): WindowQuery | undefined => {
  const from = zonedMidnight(date, timezone);
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const to = zonedMidnight(formatDate(next, 'UTC'), timezone);
  return from && to && to > from ? { from: from.toISOString(), to: to.toISOString(), limit: 20 } : undefined;
};
const displayTime = (instant: string, timezone: string) => new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(instant));

export function ClinicianDetailPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const timezone = viewerTimezone();
  const defaultDate = formatDate(new Date(), timezone);
  const date = searchParams.get('date') ?? defaultDate;
  const [cursor, setCursor] = useState<string>();
  useEffect(() => { if (!searchParams.get('date')) { const next = new URLSearchParams(searchParams); next.set('date', defaultDate); setSearchParams(next, { replace: true }); } }, [defaultDate, searchParams, setSearchParams]);
  const window = useMemo(() => availabilityWindowForDate(date, timezone), [date, timezone]);
  const clinician = useClinician(id);
  const slots = useSlots(id, window && { ...window, cursor });
  const setDate = (value: string) => { const next = new URLSearchParams(searchParams); next.set('date', value); setCursor(undefined); setSearchParams(next); };
  return <section aria-labelledby="clinician-title" className="space-y-8">
    {clinician.isPending && <div role="status" aria-busy="true">Loading clinician</div>}
    {clinician.isError && <div role="alert" className="error-message">{clinician.error instanceof Error ? clinician.error.message : 'We could not load this clinician.'}</div>}
    {clinician.data && <><header><p className="eyebrow">{clinician.data.specialty}</p><h1 id="clinician-title">{clinician.data.displayName}</h1><p className="mt-3 max-w-2xl text-muted-foreground">{clinician.data.biography}</p><p className="mt-3 text-sm">Profile timezone: {clinician.data.timezone}. Appointment times below use your timezone: {timezone}.</p></header>
      <div className="max-w-sm"><label htmlFor="appointment-date" className="block text-sm font-semibold">Date</label><input id="appointment-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border bg-surface px-3" /></div>
      {!window && <p role="alert" className="error-message">Choose a valid appointment date.</p>}
      {window && slots.isPending && <div role="status" aria-busy="true">Loading available times</div>}
      {slots.isError && <div role="alert" className="error-message"><p>{slots.error instanceof Error ? slots.error.message : 'We could not load available times.'}</p><Button onClick={() => void slots.refetch()}>Try again</Button></div>}
      {slots.data && <BookingForm slots={slots.data.items} timezone={timezone} formatSlot={(slot) => displayTime(slot.startAt, timezone)} />}
      {slots.data?.nextCursor && <Button variant="outline" onClick={() => setCursor(slots.data?.nextCursor ?? undefined)}>More available times</Button>}
    </>}
  </section>;
}
