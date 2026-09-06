import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppointmentSchema, PageSchema, type BookInput, type CancelInput } from '@portal/contracts';

import { ApiClientError } from '../../lib/api';
import { useApiClient, useSession } from '../auth/auth-provider';

const AppointmentPageSchema = PageSchema(AppointmentSchema);

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
    mutationFn: (input: BookInput) => api('/appointments', { method: 'POST', body: JSON.stringify(input) }, AppointmentSchema),
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
      if (error instanceof ApiClientError && error.code === 'NETWORK_ERROR') {
        await queryClient.refetchQueries({ queryKey: [sub, 'appointments'] });
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
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: [sub, 'appointments'] }); },
  });
}
