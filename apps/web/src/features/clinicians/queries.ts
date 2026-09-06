import { useQuery } from '@tanstack/react-query';
import { ClinicianSchema, PageSchema, SlotSchema, type WindowQuery } from '@portal/contracts';

import { useApiClient, useSession } from '../auth/auth-provider';

const ClinicianPageSchema = PageSchema(ClinicianSchema);
const SlotPageSchema = PageSchema(SlotSchema);

export function useClinicians(cursor?: string) {
  const api = useApiClient();
  const { sub } = useSession();
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return useQuery({
    queryKey: [sub, 'clinicians', cursor ?? 'first'],
    queryFn: ({ signal }) => api(`/clinicians?${query}`, { signal }, ClinicianPageSchema),
    enabled: Boolean(sub),
  });
}

export function useClinician(id: string | undefined) {
  const api = useApiClient();
  const { sub } = useSession();
  return useQuery({
    queryKey: [sub, 'clinician', id],
    queryFn: ({ signal }) => api(`/clinicians/${id}`, { signal }, ClinicianSchema),
    enabled: Boolean(sub && id),
  });
}

export function useSlots(clinicianId: string | undefined, window: WindowQuery | undefined) {
  const api = useApiClient();
  const { sub } = useSession();
  const query = window && new URLSearchParams({
    from: window.from,
    to: window.to,
    limit: String(window.limit),
    ...(window.cursor ? { cursor: window.cursor } : {}),
  });
  return useQuery({
    queryKey: [sub, 'slots', clinicianId, window?.from, window?.to, window?.cursor ?? 'first'],
    queryFn: ({ signal }) => api(`/clinicians/${clinicianId}/slots?${query}`, { signal }, SlotPageSchema),
    enabled: Boolean(sub && clinicianId && window && query),
  });
}
