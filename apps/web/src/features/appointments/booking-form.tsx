import { zodResolver } from '@hookform/resolvers/zod';
import type { Slot } from '@portal/contracts';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../../components/ui/button';
import { ApiClientError } from '../../lib/api';
import { useBookAppointment } from './queries';

const BookingSchema = z.object({ slotId: z.uuid() });
type BookingValues = z.infer<typeof BookingSchema>;

export function BookingForm({ slots, timezone, formatSlot }: { slots: Slot[]; timezone: string; formatSlot(slot: Slot): string }) {
  const form = useForm<BookingValues>({ resolver: zodResolver(BookingSchema), defaultValues: { slotId: slots[0]?.id } });
  const booking = useBookAppointment();
  const [message, setMessage] = useState<string>();
  useEffect(() => { if (!slots.some((slot) => slot.id === form.getValues('slotId'))) form.setValue('slotId', slots[0]?.id ?? '', { shouldValidate: true }); }, [form, slots]);
  const submit = async (values: BookingValues) => {
    setMessage(undefined);
    try {
      await booking.mutateAsync(values);
      setMessage('Appointment confirmed');
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) setMessage('This slot was just booked. Please choose another.');
      else if (error instanceof ApiClientError && error.code === 'NETWORK_ERROR') setMessage('We could not confirm the booking. Your appointments were refreshed before you try again.');
      else setMessage(error instanceof Error ? error.message : 'We could not book this appointment.');
    }
  };
  return <form onSubmit={form.handleSubmit(submit)} aria-label="Book an appointment" className="space-y-5">
    <fieldset disabled={booking.isPending}><legend className="text-lg font-semibold">Available times</legend><p className="mt-1 text-sm text-muted-foreground">Times are shown in your timezone: {timezone}.</p>{slots.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{slots.map((slot) => <label key={slot.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border bg-surface p-3 has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary"><input type="radio" value={slot.id} {...form.register('slotId')} /><span>{formatSlot(slot)}</span></label>)}</div> : <p role="status" className="mt-3 rounded-md border bg-surface p-4">No available times on this date.</p>}</fieldset>
    {message && <p role={message === 'Appointment confirmed' ? 'status' : 'alert'} className={message === 'Appointment confirmed' ? 'rounded-md border bg-surface p-3' : 'error-message'}>{message}</p>}
    <Button type="submit" aria-label="Book appointment" disabled={booking.isPending || !form.watch('slotId')}>{booking.isPending ? 'Booking appointment…' : 'Book appointment'}</Button>
  </form>;
}
