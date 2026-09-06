import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { WindowQuery } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { formatAppointmentTime } from '../../lib/time';
import { BookingForm } from '../appointments/booking-form';
import { useClinician, useSlots } from './queries';

const viewerTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const formatDate = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};
const localParts = (date: Date, timezone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
const parseCalendarDate = (date: string) => {
  const match = datePattern.exec(date);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day ? { year, month, day, instant } : undefined;
};
const zonedMidnight = ({ year, month, day, instant }: NonNullable<ReturnType<typeof parseCalendarDate>>, timezone: string): Date | undefined => {
  const intended = instant.getTime();
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) {
    const candidate = new Date(intended + hours * 60 * 60 * 1_000);
    const parts = localParts(candidate, timezone);
    offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - candidate.getTime());
  }
  const matches = [...offsets].map((offset) => new Date(intended - offset)).filter((candidate) => {
    const parts = localParts(candidate, timezone);
    return parts.year === year && parts.month === month && parts.day === day && parts.hour === 0 && parts.minute === 0 && parts.second === 0;
  });
  return matches.sort((left, right) => left.getTime() - right.getTime())[0];
};
export const availabilityWindowForDate = (date: string, timezone: string): WindowQuery | undefined => {
  const current = parseCalendarDate(date);
  if (!current) return undefined;
  const next = new Date(current.instant);
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = parseCalendarDate(next.toISOString().slice(0, 10));
  const from = zonedMidnight(current, timezone);
  const to = tomorrow && zonedMidnight(tomorrow, timezone);
  return from && to && to > from ? { from: from.toISOString(), to: to.toISOString(), limit: 20 } : undefined;
};

export function ClinicianDetailPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const timezone = viewerTimezone();
  const defaultDate = formatDate(new Date(), timezone);
  const hasDate = searchParams.has('date');
  const date = hasDate ? searchParams.get('date') ?? '' : defaultDate;
  const slotScope = `${id ?? ''}:${date}`;
  const [slotCursor, setSlotCursor] = useState<{ scope: string; value?: string }>({ scope: slotScope });
  const cursor = slotCursor.scope === slotScope ? slotCursor.value : undefined;
  useEffect(() => { if (!hasDate) { const next = new URLSearchParams(searchParams); next.set('date', defaultDate); setSearchParams(next, { replace: true }); } }, [defaultDate, hasDate, searchParams, setSearchParams]);
  const window = useMemo(() => availabilityWindowForDate(date, timezone), [date, timezone]);
  const clinician = useClinician(id);
  const slots = useSlots(id, window && { ...window, cursor });
  const setDate = (value: string) => { const next = new URLSearchParams(searchParams); next.set('date', value); setSearchParams(next); };
  return <section aria-labelledby="clinician-title" className="space-y-8">
    {clinician.isPending && <div role="status" aria-busy="true">Loading clinician</div>}
    {clinician.isError && <div role="alert" className="error-message"><p>{clinician.error instanceof Error ? clinician.error.message : 'We could not load this clinician.'}</p><Button onClick={() => void clinician.refetch()}>Try again</Button></div>}
    {clinician.data && <><header><p className="eyebrow">{clinician.data.specialty}</p><h1 id="clinician-title">{clinician.data.displayName}</h1><p className="mt-3 max-w-2xl text-muted-foreground">{clinician.data.biography}</p><p className="mt-3 text-sm">Profile timezone: {clinician.data.timezone}. Appointment times below use your timezone: {timezone}.</p></header>
      <div className="max-w-sm"><label htmlFor="appointment-date" className="block text-sm font-semibold">Date</label><input id="appointment-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border bg-surface px-3" /></div>
      {!window && <p role="alert" className="error-message">Choose a valid appointment date.</p>}
      {window && slots.isPending && <div role="status" aria-busy="true">Loading available times</div>}
      {slots.isError && <div role="alert" className="error-message"><p>{slots.error instanceof Error ? slots.error.message : 'We could not load available times.'}</p><Button onClick={() => void slots.refetch()}>Try again</Button></div>}
      {slots.data && <BookingForm slots={slots.data.items} timezone={timezone} formatSlot={(slot) => formatAppointmentTime(slot.startAt, timezone)} />}
      {slots.data?.nextCursor && <Button variant="outline" onClick={() => setSlotCursor({ scope: slotScope, value: slots.data?.nextCursor ?? undefined })}>More available times</Button>}
    </>}
  </section>;
}
