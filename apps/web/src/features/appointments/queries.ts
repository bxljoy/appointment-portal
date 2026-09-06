import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppointmentSchema, PageSchema, type Appointment, type BookInput, type CancelInput, type Page } from '@portal/contracts';

import { ApiClientError } from '../../lib/api';
import { useApiClient, useSession } from '../auth/auth-provider';

const AppointmentPageSchema = PageSchema(AppointmentSchema);

export class BookingReconciliationError extends Error {
  constructor() {
    super('We could not determine whether your booking was created.');
    this.name = 'BookingReconciliationError';
  }
}

export type BookingOutcome = 'confirmed' | 'not-confirmed';

async function reconcileBooking(api: ReturnType<typeof useApiClient>, slotId: string): Promise<BookingOutcome> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const query = new URLSearchParams({ limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const page = await api(`/appointments?${query}`, {}, AppointmentPageSchema);
    if (page.items.some((appointment) => appointment.slotId === slotId && appointment.status === 'booked')) return 'confirmed';
    const nextCursor = page.nextCursor;
    if (nextCursor === null) return 'not-confirmed';
    if (!nextCursor.trim() || seenCursors.has(nextCursor)) throw new BookingReconciliationError();
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new BookingReconciliationError();
}

export function useAppointments(cursor?: string) {
  const api = useApiClient();
  const { sub } = useSession();
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return useQuery({
    queryKey: [sub, 'appointments', cursor ?? 'first'],
    queryFn: ({ signal }) => api(`/appointments?${query}`, { signal }, AppointmentPageSchema),
    enabled: Boolean(sub),
  });
}

export function useBookAppointment() {
  const api = useApiClient();
  const { sub } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [sub, 'appointments', 'book'],
    mutationFn: async (input: BookInput): Promise<BookingOutcome> => {
      try {
        await api('/appointments', { method: 'POST', body: JSON.stringify(input) }, AppointmentSchema);
        return 'confirmed';
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== 'NETWORK_ERROR') throw error;
        try {
          // This endpoint is server-scoped to the authenticated caller, so a booked
          // record for the selected slot is necessarily the current patient's booking.
          return await reconcileBooking(api, input.slotId);
        } catch {
          throw new BookingReconciliationError();
        }
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [sub, 'slots'] }),
        queryClient.invalidateQueries({ queryKey: [sub, 'appointments'] }),
      ]);
    },
    onError: async (error) => {
      if (error instanceof ApiClientError && error.status === 409) {
        await queryClient.refetchQueries({ queryKey: [sub, 'slots'] });
      }
    },
  });
}

export function useCancelAppointment() {
  const api = useApiClient();
  const { sub } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [sub, 'appointments', 'cancel'],
    mutationFn: ({ appointmentId, withdrawSlot = false }: { appointmentId: string } & CancelInput) =>
      api(`/appointments/${appointmentId}/cancel`, { method: 'POST', body: JSON.stringify({ withdrawSlot }) }, AppointmentSchema),
    onSuccess: async (cancelledAppointment) => {
      queryClient.setQueriesData<Page<Appointment>>({ queryKey: [sub, 'appointments'] }, (page) => page && {
        ...page,
        items: page.items.map((appointment) => appointment.id === cancelledAppointment.id ? cancelledAppointment : appointment),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [sub, 'appointments'] }),
        queryClient.invalidateQueries({ queryKey: [sub, 'slots'] }),
        queryClient.invalidateQueries({ queryKey: [sub, 'availability'] }),
      ]);
    },
  });
}
