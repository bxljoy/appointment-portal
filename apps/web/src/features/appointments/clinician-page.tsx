import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Appointment, Me } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { formatAppointmentTime } from '../../lib/time';
import { useSession } from '../auth/auth-provider';
import { useClinician } from '../clinicians/queries';
import { CancelDialog } from './cancel-dialog';
import { useAppointments } from './queries';

const started = (appointment: Appointment) => new Date(appointment.startAt).getTime() <= Date.now();
const mergeAppointments = (current: Appointment[], incoming: Appointment[]) => [...new Map([...current, ...incoming].map((appointment) => [appointment.id, appointment])).values()];

export function ClinicianAppointmentsPage() {
  const me = useOutletContext<Me>();
  const { sub } = useSession();
  const subjectScope = sub ?? '';
  const profile = useClinician(me.id);
  const timezone = profile.data?.timezone;
  const [cursor, setCursor] = useState<{ scope: string; value?: string }>({ scope: subjectScope });
  const page = useAppointments(cursor.scope === subjectScope ? cursor.value : undefined);
  const [loaded, setLoaded] = useState<{ scope: string; items: Appointment[]; nextCursor: string | null }>();
  const historyHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!page.data) return;
    setLoaded((current) => ({ scope: subjectScope, items: mergeAppointments(current?.scope === subjectScope ? current.items : [], page.data.items), nextCursor: page.data.nextCursor }));
  }, [page.data, subjectScope]);
  const appointments = loaded?.scope === subjectScope ? loaded.items : [];
  const nextCursor = loaded?.scope === subjectScope ? loaded.nextCursor : null;
  const onCancelled = (cancelled: Appointment) => setLoaded((current) => current?.scope === subjectScope ? { ...current, items: mergeAppointments(current.items.filter((appointment) => appointment.id !== cancelled.id), [cancelled]) } : current);
  const upcoming = appointments.filter((appointment) => appointment.status === 'booked' && !started(appointment));
  const history = appointments.filter((appointment) => appointment.status === 'cancelled' || started(appointment));
  const rows = (items: Appointment[], empty: string) => items.length && timezone ? <div className="mt-4 overflow-x-auto"><table className="w-full border-collapse text-left"><thead><tr className="border-b"><th className="p-3 font-semibold">Patient</th><th className="p-3 font-semibold">Time</th><th className="p-3 font-semibold">Status</th><th className="p-3"><span className="sr-only">Actions</span></th></tr></thead><tbody>{items.map((appointment) => <tr key={appointment.id} className="border-b align-top"><td className="p-3 font-medium">{appointment.patientDisplayName}</td><td className="p-3">{formatAppointmentTime(appointment.startAt, timezone)}</td><td className="p-3">{appointment.status === 'cancelled' ? 'Cancelled' : started(appointment) ? 'Started appointment' : 'Upcoming appointment'}</td><td className="p-3">{appointment.status === 'booked' && !started(appointment) && <CancelDialog appointment={appointment} clinician counterpartyName={appointment.patientDisplayName} onCancelled={onCancelled} onRestoreFocus={() => historyHeading.current?.focus()} />}</td></tr>)}</tbody></table></div> : <p role="status" className="mt-4 rounded-md border bg-surface p-5">{empty}</p>;
  return <section aria-labelledby="schedule-appointments-title" className="space-y-8"><header><p className="eyebrow">Your schedule</p><h1 id="schedule-appointments-title">Your appointments</h1><p className="mt-3 text-muted-foreground">Patient names are fictional. {timezone ? `Times use your profile timezone: ${timezone}.` : 'Loading your profile timezone.'}</p></header>
    {profile.isError && <div role="alert" className="error-message"><p>We could not load your profile timezone.</p><Button onClick={() => void profile.refetch()}>Try again</Button></div>}
    {page.isPending && appointments.length === 0 && <p role="status" aria-busy="true">Loading appointments</p>}
    {page.isError && <div role="alert" className="error-message"><p>{page.error instanceof Error ? page.error.message : 'We could not load your appointments.'}</p><Button onClick={() => void page.refetch()}>Try again</Button></div>}
    {timezone && (page.data || appointments.length > 0) && <><section aria-labelledby="upcoming-appointments-title"><h2 id="upcoming-appointments-title" className="text-xl">Upcoming appointments</h2>{rows(upcoming, 'You have no upcoming appointments.')}</section><section aria-labelledby="appointment-history-title"><h2 id="appointment-history-title" ref={historyHeading} tabIndex={-1} className="text-xl">Appointment history</h2>{rows(history, 'Cancelled and completed appointments will appear here.')}</section>{nextCursor && <Button variant="outline" onClick={() => setCursor({ scope: subjectScope, value: nextCursor })} disabled={page.isFetching}>{page.isFetching ? 'Loading more appointments…' : 'Load more appointments'}</Button>}</>}
  </section>;
}
