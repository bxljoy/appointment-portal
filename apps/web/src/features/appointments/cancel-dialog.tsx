import { useState } from 'react';
import type { Appointment } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { useCancelAppointment } from './queries';

export function CancelDialog({ appointment }: { appointment: Appointment }) {
  const [open, setOpen] = useState(false);
  const cancellation = useCancelAppointment();
  const cancel = async () => {
    try {
      await cancellation.mutateAsync({ appointmentId: appointment.id, withdrawSlot: false });
      setOpen(false);
    } catch {
      // The server result remains authoritative. Keep the dialog open with a retryable error.
    }
  };
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="outline" disabled={cancellation.isPending} aria-label={`Cancel appointment with ${appointment.clinicianDisplayName}`}>Cancel appointment</Button></DialogTrigger>
    <DialogContent aria-describedby="cancel-description">
      <DialogTitle>Cancel appointment</DialogTitle>
      <DialogDescription id="cancel-description">Cancel your appointment with {appointment.clinicianDisplayName}? The time will become available to book again.</DialogDescription>
      {cancellation.isError && <p role="alert" className="error-message">{cancellation.error instanceof Error ? cancellation.error.message : 'We could not cancel this appointment.'}</p>}
      <div className="mt-6 flex flex-wrap gap-3"><Button variant="destructive" onClick={() => void cancel()} disabled={cancellation.isPending}>{cancellation.isPending ? 'Cancelling…' : 'Confirm cancellation'}</Button><Button variant="outline" onClick={() => setOpen(false)} disabled={cancellation.isPending}>Keep appointment</Button></div>
    </DialogContent>
  </Dialog>;
}
