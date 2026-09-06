import { Temporal } from '@js-temporal/polyfill';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '../../components/ui/button';
import { formatAppointmentTime, localMinuteToInstant } from '../../lib/time';
import type { Slot } from '@portal/contracts';

import { useCreateSlot } from './queries';

type SlotFormValues = { startAt: string };

export function SlotForm({ timezone, onCreated }: { timezone: string; onCreated?(slot: Slot): void }) {
  const form = useForm<SlotFormValues>({ defaultValues: { startAt: '' } });
  const creation = useCreateSlot();
  const [message, setMessage] = useState<string>();
  const localStart = form.watch('startAt');
  let startAt: string | undefined;
  let validationMessage: string | undefined;
  try {
    if (localStart) startAt = localMinuteToInstant(localStart, timezone);
    if (startAt && Temporal.Instant.compare(Temporal.Instant.from(startAt), Temporal.Now.instant()) <= 0) {
      validationMessage = 'Choose a future time.';
    }
  } catch {
    validationMessage = `Choose an unambiguous local time in ${timezone}. Daylight-saving skipped and repeated times cannot be used.`;
  }
  const endAt = startAt ? Temporal.Instant.from(startAt).add({ minutes: 30 }).toString() : undefined;
  const submit = async () => {
    setMessage(undefined);
    if (!startAt || validationMessage) {
      setMessage(validationMessage ?? 'Choose a local time.');
      return;
    }
    try {
      const created = await creation.mutateAsync({ startAt });
      onCreated?.(created);
      form.reset();
      setMessage('Slot published');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'We could not publish this slot.');
    }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Publish availability" className="max-w-xl space-y-4 rounded-md border bg-surface p-5">
    <div><label htmlFor="slot-start" className="block text-sm font-semibold">Start time</label><input id="slot-start" type="datetime-local" step="60" {...form.register('startAt')} aria-describedby="slot-timezone slot-end" className="mt-2 min-h-11 w-full rounded-md border bg-background px-3" /></div>
    <p id="slot-timezone" className="text-sm text-muted-foreground">Timezone: {timezone}.</p>
    {endAt && !validationMessage && <p id="slot-end" role="status" className="text-sm">Ends at {formatAppointmentTime(endAt, timezone)} (30 minutes).</p>}
    {validationMessage && <p role="alert" className="error-message">{validationMessage}</p>}
    {message && <p role={message === 'Slot published' ? 'status' : 'alert'} className={message === 'Slot published' ? 'rounded-md border bg-background p-3' : 'error-message'}>{message}</p>}
    <Button type="submit" disabled={creation.isPending}>{creation.isPending ? 'Publishing slot…' : 'Publish slot'}</Button>
  </form>;
}
