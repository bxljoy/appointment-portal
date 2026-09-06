import { ApiErrorBodySchema } from '@portal/contracts';
import type { z } from 'zod';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

const fallbackError = (status: number): ApiClientError => {
  if (status === 401) return new ApiClientError(status, 'UNAUTHENTICATED', 'Please sign in to continue.');
  if (status === 403) return new ApiClientError(status, 'FORBIDDEN', 'You do not have access to this page.');
  if (status === 429) return new ApiClientError(status, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
  if (status >= 500) return new ApiClientError(status, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Please try again.');
  return new ApiClientError(status, 'REQUEST_FAILED', 'The request could not be completed. Please try again.');
};

const apiPath = (path: string): string => {
  // Never let a caller move a credentialed request outside the same-origin API.
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\s]/u.test(path) || /%2e|%2f|%5c/i.test(path.split('?')[0] ?? '')) {
    throw new ApiClientError(0, 'INVALID_REQUEST', 'The API path is invalid.');
  }
  const url = new URL(`/api${path}`, 'https://portal.invalid');
  if (!url.pathname.startsWith('/api/')) throw new ApiClientError(0, 'INVALID_REQUEST', 'The API path is invalid.');
  return `/api${path}`;
};

export const createApiClient = (getHeaders: () => Record<string, string>) =>
  async <T>(path: string, options: RequestInit, schema: z.ZodType<T>): Promise<T> => {
    const url = apiPath(path);
    const headers = new Headers(options.headers);
    // Authentication belongs to the provider, never to a component's options.
    headers.delete('Authorization');
    headers.set('Accept', 'application/json');
    if (options.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    for (const [key, value] of Object.entries(getHeaders())) headers.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, { ...options, headers, credentials: 'same-origin', redirect: 'error' });
    } catch (error) {
      if (options.signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')) throw error;
      throw new ApiClientError(0, 'NETWORK_ERROR', 'We could not reach the service. Check your connection.');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (options.signal?.aborted || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')) throw error;
      if (!response.ok) throw fallbackError(response.status);
      throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The service returned an unexpected response.');
    }
    if (!response.ok) {
      const parsed = ApiErrorBodySchema.safeParse(body);
      if (parsed.success) {
        const { code, message, fieldErrors } = parsed.data.error;
        throw new ApiClientError(response.status, code, message, fieldErrors);
      }
      throw fallbackError(response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiClientError(response.status, 'INVALID_RESPONSE', 'The service returned an unexpected response.');
    return parsed.data;
  };

export type ApiRequest = ReturnType<typeof createApiClient>;
export const retryQuery = (failureCount: number, error: unknown): boolean =>
  failureCount < 1 && error instanceof ApiClientError && [500, 502, 503, 504].includes(error.status);
