import { describe, expect, it } from 'vitest';

import { formatAppointmentTime, localMinuteToInstant } from './time';

describe('timezone-safe appointment times', () => {
  it('rejects skipped and repeated local times', () => {
    expect(() => localMinuteToInstant('2026-03-29T02:30', 'Europe/Stockholm')).toThrow();
    expect(() => localMinuteToInstant('2026-10-25T02:30', 'Europe/Stockholm')).toThrow();
    expect(localMinuteToInstant('2026-09-05T10:00', 'Europe/Stockholm'))
      .toBe('2026-09-05T08:00:00Z');
  });

  it.each([
    ['2026-09-05T10:00:30', 'Europe/Stockholm'],
    ['2026-09-05T10:00.000', 'Europe/Stockholm'],
    ['not-a-time', 'Europe/Stockholm'],
    ['2026-09-05T10:00', 'Not/AZone'],
  ])('rejects an invalid local minute: %s in %s', (local, zone) => {
    expect(() => localMinuteToInstant(local, zone)).toThrow();
  });

  it('formats appointment instants in the selected viewer timezone', () => {
    expect(formatAppointmentTime('2026-09-05T08:00:00Z', 'Europe/Stockholm'))
      .toContain('10:00');
  });
});
