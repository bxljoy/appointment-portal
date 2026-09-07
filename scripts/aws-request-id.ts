const REQUEST_ID = /^[A-Za-z0-9_-]{8,126}={0,2}$/;
const REQUEST_ID_MARKER = /^PORTAL_REQUEST_ID:([A-Za-z0-9_-]{8,126}={0,2})$/;

export const isAwsRequestId = (value: string): boolean => REQUEST_ID.test(value);

export function parseRequestIdMarkers(stdout: string): string[] {
  if (Buffer.byteLength(stdout, 'utf8') > 1_000_000) throw new Error('AWS verification output exceeded the safe size limit.');
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = REQUEST_ID_MARKER.exec(line);
    return match ? [match[1]!] : [];
  });
}
