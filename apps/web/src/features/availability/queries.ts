import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageSchema, SlotSchema, type CreateSlotInput, type WindowQuery } from '@portal/contracts';

import { useApiClient, useSession } from '../auth/auth-provider';

const SlotPageSchema = PageSchema(SlotSchema);

export function useOwnSlots(window: WindowQuery | undefined) {
  const api = useApiClient();
  const { sub } = useSession();
  const query = window && new URLSearchParams({
    from: window.from,
    to: window.to,
    limit: String(window.limit),
    ...(window.cursor ? { cursor: window.cursor } : {}),
  });
  return useQuery({
    queryKey: [sub, 'availability', window?.from, window?.to, window?.cursor ?? 'first'],
    queryFn: ({ signal }) => api(`/availability?${query}`, { signal }, SlotPageSchema),
    enabled: Boolean(sub && window && query),
  });
}

export function useCreateSlot() {
  const api = useApiClient();
  const { sub } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [sub, 'availability', 'create'],
    mutationFn: (input: CreateSlotInput) => api('/availability', { method: 'POST', body: JSON.stringify(input) }, SlotSchema),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [sub, 'availability'] }),
        queryClient.invalidateQueries({ queryKey: [sub, 'slots'] }),
      ]);
    },
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
