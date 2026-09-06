import { z } from 'zod';

export const FieldErrorsSchema = z.record(z.string(), z.array(z.string()));

export const ApiErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().min(1),
  fieldErrors: FieldErrorsSchema.optional(),
});

export const ApiErrorBodySchema = z.strictObject({
  error: ApiErrorSchema,
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
export type FieldErrors = z.infer<typeof FieldErrorsSchema>;

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: FieldErrors | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    fieldErrors?: FieldErrors,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}
