import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageSchema, SlotSchema, type CreateSlotInput } from '@portal/contracts';

import { useApiClient, useSession } from '../auth/auth-provider';

const SlotPageSchema = PageSchema(SlotSchema);

export function useOwnSlots(cursor?: string) {
  const api = useApiClient();
  const { sub } = useSession();
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  return useQuery({
    queryKey: [sub, 'availability', cursor ?? 'first'],
    queryFn: ({ signal }) => api(`/availability?${query}`, { signal }, SlotPageSchema),
    enabled: Boolean(sub),
  });
}

export function useCreateSlot() {
  const api = useApiClient();
  const { sub } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [sub, 'availability', 'create'],
    mutationFn: (input: CreateSlotInput) => api('/availability', { method: 'POST', body: JSON.stringify(input) }, SlotSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [sub, 'availability'] }),
  });
}

export function useWithdrawSlot() {
  const api = useApiClient();
  const { sub } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [sub, 'availability', 'withdraw'],
    mutationFn: (slotId: string) => api(`/availability/${slotId}/withdraw`, { method: 'POST' }, SlotSchema),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [sub, 'availability'] }),
        queryClient.invalidateQueries({ queryKey: [sub, 'slots'] }),
      ]);
    },
  });
}
