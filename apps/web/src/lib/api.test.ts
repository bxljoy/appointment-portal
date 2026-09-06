import { MeSchema } from '@portal/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient, retryQuery } from './api';

const me = { id: '10000000-0000-4000-8000-000000000001', displayName: 'Alice Patient', role: 'patient' };
const respond = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status })));

describe('API transport', () => {
  it('normalizes gateway authentication errors', async () => {
    respond({ message: 'Unauthorized' }, 401);
    await expect(createApiClient(() => ({}))('/me', { method: 'GET' }, MeSchema))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
  it('turns malformed gateway JSON into a safe error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>secret upstream detail</html>', { status: 502 })));
    await expect(createApiClient(() => ({}))('/me', {}, MeSchema))
      .rejects.toMatchObject({ status: 502, code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Please try again.' });
  });
  it('preserves contract error fields', async () => {
    respond({ error: { code: 'VALIDATION_ERROR', message: 'Check your details.', requestId: 'test', fieldErrors: { startAt: ['Choose a future time.'] } } }, 400);
    await expect(createApiClient(() => ({}))('/availability', { method: 'POST', body: '{}' }, MeSchema))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR', fieldErrors: { startAt: ['Choose a future time.'] } });
  });
  it('validates success data without leaking schema details', async () => {
    respond({ ...me, role: 'admin' });
    await expect(createApiClient(() => ({}))('/me', {}, MeSchema)).rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE', message: 'The service returned an unexpected response.' });
  });
  it('reads current headers, keeps options and forwards abort signal', async () => {
    respond(me);
    let current = 'first';
    const request = createApiClient(() => ({ Authorization: `Bearer ${current}` }));
    const signal = new AbortController().signal;
    await request('/me', { signal, headers: { 'X-Request-Test': 'yes' } }, MeSchema);
    current = 'second';
    await request('/me', {}, MeSchema);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0]?.[0]).toBe('/api/me');
    expect(calls[0]?.[1]?.signal).toBe(signal);
    expect(new Headers(calls[0]?.[1]?.headers).get('X-Request-Test')).toBe('yes');
    expect(new Headers(calls[1]?.[1]?.headers).get('Authorization')).toBe('Bearer second');
  });
  it('does not retry ambiguous mutation failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(createApiClient(() => ({}))('/appointments', { method: 'POST', body: '{}' }, MeSchema)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves abort cancellation', async () => {
    const aborted = new DOMException('Cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
    await expect(createApiClient(() => ({}))('/me', {}, MeSchema)).rejects.toBe(aborted);
  });
  it.each(['https://example.org/me', '//example.org/me', '/../config.json', '/%2e%2e/config.json', '/me#fragment'])('rejects an unsafe API path: %s', async (path) => {
    respond(me);
    await expect(createApiClient(() => ({}))(path, {}, MeSchema)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retries only transient server failures once', () => {
    expect(retryQuery(0, new ApiClientError(503, 'UNAVAILABLE', 'Unavailable'))).toBe(true);
    for (const status of [401, 403, 409, 429, 501, 200]) expect(retryQuery(0, new ApiClientError(status, 'ERROR', 'Error'))).toBe(false);
    expect(retryQuery(1, new ApiClientError(503, 'UNAVAILABLE', 'Unavailable'))).toBe(false);
    expect(retryQuery(0, new Error('Unknown'))).toBe(false);
  });
});
