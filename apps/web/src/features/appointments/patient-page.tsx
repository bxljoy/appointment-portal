import { useEffect, useRef, useState } from 'react';
import type { Appointment } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { CancelDialog } from './cancel-dialog';
import { useAppointments } from './queries';

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const showTime = (value: string, viewerTimezone: string) => new Intl.DateTimeFormat(undefined, { timeZone: viewerTimezone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
const started = (appointment: Appointment) => new Date(appointment.startAt).getTime() <= Date.now();

function AppointmentRow({ appointment, viewerTimezone, onCancelled, onRestoreFocus }: { appointment: Appointment; viewerTimezone: string; onCancelled(appointment: Appointment): void; onRestoreFocus(): void }) {
  const canCancel = appointment.status === 'booked' && !started(appointment);
  return <li className="flex flex-col gap-3 rounded-md border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-semibold">{appointment.clinicianDisplayName}</h3><p className="text-sm text-muted-foreground">{showTime(appointment.startAt, viewerTimezone)}</p><p className="mt-1 text-sm">{appointment.status === 'cancelled' ? 'Cancelled' : started(appointment) ? 'Started appointment' : 'Upcoming appointment'}</p></div>{canCancel && <CancelDialog appointment={appointment} onCancelled={onCancelled} onRestoreFocus={onRestoreFocus} />}</li>;
}

export function PatientAppointmentsPage() {
  const viewerTimezone = timezone();
  const [cursor, setCursor] = useState<string>();
  const [allAppointments, setAllAppointments] = useState<Appointment[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const page = useAppointments(cursor);
  useEffect(() => {
    if (!page.data) return;
    setAllAppointments((current) => {
      const byId = new Map(current.map((appointment) => [appointment.id, appointment]));
      for (const appointment of page.data.items) byId.set(appointment.id, appointment);
      return [...byId.values()];
    });
    setNextCursor(page.data.nextCursor);
  }, [page.data]);
  const future = allAppointments.filter((appointment) => appointment.status === 'booked' && !started(appointment));
  const history = allAppointments.filter((appointment) => appointment.status === 'cancelled' || started(appointment));
  const moveCancelledAppointmentToHistory = (cancelledAppointment: Appointment) => {
    setAllAppointments((current) => current.map((appointment) => appointment.id === cancelledAppointment.id ? cancelledAppointment : appointment));
  };
  const focusHistory = () => { historyHeading.current?.focus(); };
  return <section aria-labelledby="appointments-title" className="space-y-8"><header><p className="eyebrow">Your care</p><h1 id="appointments-title">Your appointments</h1><p className="mt-3 text-muted-foreground">Times are displayed in your timezone: {viewerTimezone}.</p></header>
    {page.isPending && <div role="status" aria-busy="true">Loading appointments</div>}
    {page.isError && <div role="alert" className="error-message"><p>{page.error instanceof Error ? page.error.message : 'We could not load your appointments.'}</p><Button onClick={() => void page.refetch()}>Try again</Button></div>}
    {(page.data || allAppointments.length > 0) && <><section aria-labelledby="upcoming-title"><h2 id="upcoming-title">Upcoming appointments</h2>{future.length ? <ul role="list" className="mt-4 space-y-3">{future.map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} viewerTimezone={viewerTimezone} onCancelled={moveCancelledAppointmentToHistory} onRestoreFocus={focusHistory} />)}</ul> : <p role="status" className="mt-3 rounded-md border bg-surface p-5">You have no upcoming appointments.</p>}</section>
      <section aria-labelledby="history-title"><h2 id="history-title" ref={historyHeading} tabIndex={-1}>Appointment history</h2>{history.length ? <ul role="list" className="mt-4 space-y-3">{history.map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} viewerTimezone={viewerTimezone} onCancelled={moveCancelledAppointmentToHistory} onRestoreFocus={focusHistory} />)}</ul> : <p className="mt-3 text-muted-foreground">Cancelled and completed appointments will appear here.</p>}</section>
      {nextCursor && <Button variant="outline" onClick={() => setCursor(nextCursor)} disabled={page.isFetching}>Load more appointments</Button>}</>}
  </section>;
}
