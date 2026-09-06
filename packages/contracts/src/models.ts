import { z } from 'zod';

export const OffsetDateTimeSchema = z.iso.datetime({ offset: true });
export const DirectoryNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, 'Directory names cannot be blank');

export const RoleSchema = z.enum(['patient', 'clinician']);

const APPOINTMENT_DURATION_MS = 30 * 60 * 1_000;

const requireThirtyMinuteInterval = (
  { startAt, endAt }: { startAt: string; endAt: string },
  context: z.RefinementCtx,
) => {
  if (Date.parse(endAt) - Date.parse(startAt) !== APPOINTMENT_DURATION_MS) {
    context.addIssue({
      code: 'custom',
      message: 'endAt must be 30 minutes after startAt',
      path: ['endAt'],
    });
  }
};

export const MeSchema = z.strictObject({
  id: z.uuid(),
  displayName: DirectoryNameSchema,
  role: RoleSchema,
});

export const ClinicianSchema = z.strictObject({
  id: z.uuid(),
  displayName: DirectoryNameSchema,
  biography: z.string().max(5_000),
  specialty: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
});

export const SlotSchema = z
  .strictObject({
    id: z.uuid(),
    clinicianId: z.uuid(),
    startAt: OffsetDateTimeSchema,
    endAt: OffsetDateTimeSchema,
    status: z.enum(['open', 'withdrawn']),
    isBooked: z.boolean(),
  })
  .superRefine(requireThirtyMinuteInterval);

export const AppointmentSchema = z
  .strictObject({
    id: z.uuid(),
    slotId: z.uuid(),
    clinicianId: z.uuid(),
    patientId: z.uuid(),
    patientDisplayName: DirectoryNameSchema,
    clinicianDisplayName: DirectoryNameSchema,
    startAt: OffsetDateTimeSchema,
    endAt: OffsetDateTimeSchema,
    status: z.enum(['booked', 'cancelled']),
    cancelledAt: OffsetDateTimeSchema.nullable(),
    cancelledBy: z.uuid().nullable(),
  })
  .superRefine(requireThirtyMinuteInterval);

export const PageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.strictObject({
    items: z.array(itemSchema),
    nextCursor: z.string().max(1_024).nullable(),
  });

export type Role = z.infer<typeof RoleSchema>;
export type Me = z.infer<typeof MeSchema>;
export type Clinician = z.infer<typeof ClinicianSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type Appointment = z.infer<typeof AppointmentSchema>;
export type Page<T> = z.infer<ReturnType<typeof PageSchema<z.ZodType<T>>>>;
