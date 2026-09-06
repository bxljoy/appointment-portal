import { Temporal } from '@js-temporal/polyfill';

const localMinutePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;

export function localMinuteToInstant(local: string, zone: string): string {
  if (!localMinutePattern.test(local)) {
    throw new RangeError('Enter a local time to the minute.');
  }
  return Temporal.PlainDateTime.from(local)
    .toZonedDateTime(zone, { disambiguation: 'reject' })
    .toInstant()
    .toString();
}

export function formatAppointmentTime(instant: string, zone: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toLocaleString('en-GB', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
}
