import { z } from 'zod';

import { AppError } from './errors.js';
import { DirectoryNameSchema, OffsetDateTimeSchema } from './models.js';

const MAX_CURSOR_LENGTH = 1_024;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;

export const BookInputSchema = z.strictObject({
  slotId: z.uuid(),
});

export const CreateSlotInputSchema = z.strictObject({
  startAt: OffsetDateTimeSchema,
});

export const CancelInputSchema = z.strictObject({
  withdrawSlot: z.boolean().default(false),
});

export const PageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

export const WindowQuerySchema = PageQuerySchema.extend({
  from: OffsetDateTimeSchema,
  to: OffsetDateTimeSchema,
}).superRefine(({ from, to }, context) => {
  const start = Date.parse(from);
  const end = Date.parse(to);

  if (start >= end) {
    context.addIssue({
      code: 'custom',
      message: 'from must be before to',
      path: ['to'],
    });
  }

  if (end - start > MAX_WINDOW_MS) {
    context.addIssue({
      code: 'custom',
      message: 'Availability windows cannot exceed 31 days',
      path: ['to'],
    });
  }
});

const BaseCursorSchema = z.strictObject({
  sortValue: z.string().min(1).max(200),
  id: z.uuid(),
});

const NameCursorSchema = BaseCursorSchema.extend({
  sortValue: DirectoryNameSchema,
});

const TimeCursorSchema = BaseCursorSchema.extend({
  sortValue: OffsetDateTimeSchema,
});

export type BookInput = z.infer<typeof BookInputSchema>;
export type CreateSlotInput = z.infer<typeof CreateSlotInputSchema>;
export type CancelInput = z.infer<typeof CancelInputSchema>;
export type PageQuery = z.infer<typeof PageQuerySchema>;
export type WindowQuery = z.infer<typeof WindowQuerySchema>;
export type Cursor = z.infer<typeof BaseCursorSchema>;

export function encodeCursor(value: Cursor): string {
  const cursor = BaseCursorSchema.parse(value);
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function decodeCursor(raw: string, kind: 'name' | 'time'): Cursor {
  try {
    if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
      throw new Error('Invalid base64url cursor');
    }

    const padded = raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const schema = kind === 'name' ? NameCursorSchema : TimeCursorSchema;
    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      throw new Error('Invalid cursor payload');
    }

    return parsed.data;
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'The cursor is invalid.');
  }
}
