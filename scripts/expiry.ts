export function deploymentExpiry(startedAt: Date, durationHours: number): { createdAt: string; expiresAt: string } {
  const started = startedAt.getTime();
  if (!Number.isFinite(started) || !Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 6) {
    throw new Error('Demo lifetime must be greater than zero and no more than six hours.');
  }
  return { createdAt: startedAt.toISOString(), expiresAt: new Date(started + durationHours * 60 * 60_000).toISOString() };
}
