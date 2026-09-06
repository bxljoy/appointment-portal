import type { FieldErrors } from '@portal/contracts';

export const appErrorCodes = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'SLOT_UNAVAILABLE',
  'SLOT_OVERLAP',
  'APPOINTMENT_STARTED',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL_ERROR',
] as const;

export type AppErrorCode = (typeof appErrorCodes)[number];

export class AppError extends Error {
  readonly status: number;
  readonly code: AppErrorCode;
  readonly fieldErrors: FieldErrors | undefined;

  constructor(status: number, code: AppErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}
