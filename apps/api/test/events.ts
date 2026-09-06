import type { HttpApiEvent } from '../src/shared/http.js';

export const lambdaEvent = (routeKey: string, sub?: string, body?: unknown): HttpApiEvent => {
  const separator = routeKey.indexOf(' ');
  const method = routeKey.slice(0, separator);
  const pathAndQuery = routeKey.slice(separator + 1);
  const [rawPath = '', rawQueryString = ''] = pathAndQuery.split('?');
  const queryStringParameters = Object.fromEntries(new URLSearchParams(rawQueryString));

  return {
    version: '2.0',
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    queryStringParameters,
    requestContext: {
      requestId: 'request-1',
      authorizer: { jwt: { claims: sub === undefined ? {} : { sub } } },
      http: { method },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
};
