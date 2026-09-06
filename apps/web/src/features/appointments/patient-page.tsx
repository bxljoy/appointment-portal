import type { Appointment } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { CancelDialog } from './cancel-dialog';
import { useAppointments } from './queries';

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const showTime = (value: string, viewerTimezone: string) => new Intl.DateTimeFormat(undefined, { timeZone: viewerTimezone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
const started = (appointment: Appointment) => new Date(appointment.startAt).getTime() <= Date.now();

function AppointmentRow({ appointment, viewerTimezone }: { appointment: Appointment; viewerTimezone: string }) {
  const canCancel = appointment.status === 'booked' && !started(appointment);
  return <li className="flex flex-col gap-3 rounded-md border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-semibold">{appointment.clinicianDisplayName}</h3><p className="text-sm text-muted-foreground">{showTime(appointment.startAt, viewerTimezone)}</p><p className="mt-1 text-sm">{appointment.status === 'cancelled' ? 'Cancelled' : started(appointment) ? 'Started appointment' : 'Upcoming appointment'}</p></div>{canCancel && <CancelDialog appointment={appointment} />}</li>;
}

export function PatientAppointmentsPage() {
  const appointments = useAppointments();
  const viewerTimezone = timezone();
  const future = appointments.data?.items.filter((appointment) => appointment.status === 'booked' && !started(appointment)) ?? [];
  const history = appointments.data?.items.filter((appointment) => appointment.status === 'cancelled' || started(appointment)) ?? [];
  return <section aria-labelledby="appointments-title" className="space-y-8"><header><p className="eyebrow">Your care</p><h1 id="appointments-title">Your appointments</h1><p className="mt-3 text-muted-foreground">Times are displayed in your timezone: {viewerTimezone}.</p></header>
    {appointments.isPending && <div role="status" aria-busy="true">Loading appointments</div>}
    {appointments.isError && <div role="alert" className="error-message"><p>{appointments.error instanceof Error ? appointments.error.message : 'We could not load your appointments.'}</p><Button onClick={() => void appointments.refetch()}>Try again</Button></div>}
    {appointments.data && <><section aria-labelledby="upcoming-title"><h2 id="upcoming-title">Upcoming appointments</h2>{future.length ? <ul role="list" className="mt-4 space-y-3">{future.map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} viewerTimezone={viewerTimezone} />)}</ul> : <p role="status" className="mt-3 rounded-md border bg-surface p-5">You have no upcoming appointments.</p>}</section>
      <section aria-labelledby="history-title"><h2 id="history-title">Appointment history</h2>{history.length ? <ul role="list" className="mt-4 space-y-3">{history.map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} viewerTimezone={viewerTimezone} />)}</ul> : <p className="mt-3 text-muted-foreground">Cancelled and completed appointments will appear here.</p>}</section></>}
  </section>;
}
