import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Clinician } from '@portal/contracts';

import { Button } from '../../components/ui/button';
import { useClinicians } from './queries';

export function ClinicianDirectoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [cursor, setCursor] = useState<string>();
  const [allClinicians, setAllClinicians] = useState<Clinician[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const directory = useClinicians(cursor);
  useEffect(() => {
    if (!directory.data) return;
    setAllClinicians((current) => {
      const byId = new Map(current.map((clinician) => [clinician.id, clinician]));
      for (const clinician of directory.data.items) byId.set(clinician.id, clinician);
      return [...byId.values()];
    });
    setNextCursor(directory.data.nextCursor);
  }, [directory.data]);
  const specialty = searchParams.get('specialty') ?? '';
  const clinicians = allClinicians.filter((clinician) => !specialty || clinician.specialty === specialty);
  const specialties = [...new Set(allClinicians.map((clinician) => clinician.specialty))].sort();
  const updateSpecialty = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('specialty', value); else next.delete('specialty');
    setSearchParams(next);
  };

  return <section aria-labelledby="directory-title" className="space-y-8">
    <header><p className="eyebrow">Clinician directory</p><h1 id="directory-title">Find a clinician</h1><p className="mt-3 max-w-2xl text-muted-foreground">Browse fictional clinician profiles and choose a future appointment time.</p></header>
    <div className="max-w-sm"><label htmlFor="specialty" className="block text-sm font-semibold">Specialty</label><select id="specialty" value={specialty} onChange={(event) => updateSpecialty(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border bg-surface px-3"><option value="">All specialties</option>{specialties.map((name) => <option key={name} value={name}>{name}</option>)}</select></div>
    {directory.isPending && <div role="status" aria-busy="true" className="content-loading">Loading clinicians</div>}
    {directory.isError && <div role="alert" className="error-message"><p>{directory.error instanceof Error ? directory.error.message : 'We could not load clinicians.'}</p><Button onClick={() => void directory.refetch()}>Try again</Button></div>}
    {(directory.data || allClinicians.length > 0) && clinicians.length === 0 && <div role="status" className="rounded-md border bg-surface p-6"><h2>No clinicians match this filter.</h2><p className="mt-2 text-muted-foreground">Try another specialty or check back later.</p></div>}
    {clinicians.length > 0 && <ul role="list" className="grid gap-4 sm:grid-cols-2">{clinicians.map((clinician) => <li key={clinician.id} className="rounded-md border bg-surface p-5"><h2 className="text-xl"><Link className="text-primary underline-offset-4 hover:underline" to={`/clinicians/${clinician.id}`}>{clinician.displayName}</Link></h2><p className="mt-1 font-medium">{clinician.specialty}</p><p className="mt-3 text-sm text-muted-foreground">{clinician.biography}</p><p className="mt-3 text-sm">Profile timezone: {clinician.timezone}</p></li>)}</ul>}
    {nextCursor && <Button variant="outline" onClick={() => setCursor(nextCursor)} disabled={directory.isFetching}>Load more clinicians</Button>}
  </section>;
}
