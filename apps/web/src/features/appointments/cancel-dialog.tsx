import { useRef, useState } from 'react';
import type { Appointment } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { useCancelAppointment } from './queries';

export function CancelDialog({ appointment, onCancelled, onRestoreFocus, clinician = false, counterpartyName }: { appointment: Appointment; onCancelled(appointment: Appointment): void; onRestoreFocus(): void; clinician?: boolean; counterpartyName?: string }) {
  const [open, setOpen] = useState(false);
  const [withdrawSlot, setWithdrawSlot] = useState(false);
  const shouldRestoreFallbackFocus = useRef(false);
  const cancellation = useCancelAppointment();
  const person = counterpartyName ?? appointment.clinicianDisplayName;
  const cancel = async () => {
    shouldRestoreFallbackFocus.current = true;
    try {
      const cancelledAppointment = await cancellation.mutateAsync({ appointmentId: appointment.id, withdrawSlot });
      onCancelled(cancelledAppointment);
      setOpen(false);
    } catch {
      shouldRestoreFallbackFocus.current = false;
      // The server result remains authoritative. Keep the dialog open with a retryable error.
    }
  };
  return <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) setWithdrawSlot(false); }}>
    <DialogTrigger asChild><Button variant="outline" disabled={cancellation.isPending} aria-label={`Cancel appointment with ${person}`}>Cancel appointment</Button></DialogTrigger>
    <DialogContent aria-describedby="cancel-description" onCloseAutoFocus={(event) => {
      if (!shouldRestoreFallbackFocus.current) return;
      event.preventDefault();
      shouldRestoreFallbackFocus.current = false;
      onRestoreFocus();
    }}>
      <DialogTitle>Cancel appointment</DialogTitle>
      <DialogDescription id="cancel-description">Cancel your appointment with {person}? The time will become available to book again.</DialogDescription>
      {clinician && <label className="mt-4 flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={withdrawSlot} onChange={(event) => setWithdrawSlot(event.target.checked)} disabled={cancellation.isPending} />Withdraw this slot too</label>}
      {cancellation.isError && <p role="alert" className="error-message">{cancellation.error instanceof Error ? cancellation.error.message : 'We could not cancel this appointment.'}</p>}
      <div className="mt-6 flex flex-wrap gap-3"><Button variant="destructive" aria-label="Confirm cancellation" onClick={() => void cancel()} disabled={cancellation.isPending}>{cancellation.isPending ? 'Cancelling…' : 'Confirm cancellation'}</Button><Button variant="outline" onClick={() => setOpen(false)} disabled={cancellation.isPending}>Keep appointment</Button></div>
    </DialogContent>
  </Dialog>;
}
