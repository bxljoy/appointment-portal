import { expect, it } from 'vitest';
import * as contracts from '../src/index.js';

const validId = '11111111-1111-4111-8111-111111111111';

const intervalSchemas = [
  {
    name: 'slot',
    schema: contracts.SlotSchema,
    value: {
      id: validId,
      clinicianId: '22222222-2222-4222-8222-222222222222',
      startAt: '2030-06-02T09:00:00Z',
      endAt: '2030-06-02T09:30:00Z',
      status: 'open',
      isBooked: false,
    },
  },
  {
    name: 'appointment',
    schema: contracts.AppointmentSchema,
    value: {
      id: validId,
      slotId: '22222222-2222-4222-8222-222222222222',
      clinicianId: '33333333-3333-4333-8333-333333333333',
      patientId: '44444444-4444-4444-8444-444444444444',
      patientDisplayName: 'Ada Patient',
      clinicianDisplayName: 'Dr. Lovelace',
      startAt: '2030-06-02T09:00:00Z',
      endAt: '2030-06-02T09:30:00Z',
      status: 'booked',
      cancelledAt: null,
      cancelledBy: null,
    },
  },
];

it.each(intervalSchemas)('accepts a 30-minute $name interval', ({ schema, value }) => {
  expect(schema.safeParse(value).success).toBe(true);
});

it.each(['2030-06-02T09:15:00Z', '2030-06-02T09:45:00Z', '2030-06-02T08:30:00Z'])(
  'rejects an interval ending at %s',
  (endAt) => {
    for (const { schema, value } of intervalSchemas) {
      expect(schema.safeParse({ ...value, endAt }).success).toBe(false);
    }
  },
);

it('rejects caller-supplied patient identity when booking', () => {
  expect(
    contracts.BookInputSchema.safeParse({
      slotId: validId,
      patientId: 'another-user',
    }).success,
  ).toBe(false);
});

it('requires an explicit timezone offset for a new slot', () => {
  expect(
    contracts.CreateSlotInputSchema.safeParse({
      startAt: '2030-06-02T09:00:00',
    }).success,
  ).toBe(false);
});

it('bounds page sizes at one hundred', () => {
  expect(contracts.PageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
});

it('rejects malformed cursors', () => {
  let thrown: unknown;

  try {
    contracts.decodeCursor('not-a-cursor', 'time');
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
});

it('uses stable sort values when encoding and decoding a time cursor', () => {
  const cursor = contracts.encodeCursor({
    sortValue: '2030-06-02T09:00:00+02:00',
    id: validId,
  });

  expect(contracts.decodeCursor(cursor, 'time')).toEqual({
    sortValue: '2030-06-02T09:00:00+02:00',
    id: validId,
  });
});

it('preserves the exact name sort value in a directory cursor', () => {
  const cursor = contracts.encodeCursor({
    sortValue: ' Dr. Ada Lovelace ',
    id: validId,
  });

  expect(contracts.decodeCursor(cursor, 'name')).toEqual({
    sortValue: ' Dr. Ada Lovelace ',
    id: validId,
  });
});

it('rejects availability windows longer than thirty-one days', () => {
  expect(
    contracts.WindowQuerySchema.safeParse({
      from: '2030-06-01T00:00:00Z',
      to: '2030-07-03T00:00:00Z',
    }).success,
  ).toBe(false);
});

it('requires both ends of an availability window', () => {
  expect(
    contracts.WindowQuerySchema.safeParse({ from: '2030-06-01T00:00:00Z' }).success,
  ).toBe(false);
});

it('requires availability windows to increase in time', () => {
  expect(
    contracts.WindowQuerySchema.safeParse({
      from: '2030-06-02T00:00:00Z',
      to: '2030-06-01T00:00:00Z',
    }).success,
  ).toBe(false);
});
