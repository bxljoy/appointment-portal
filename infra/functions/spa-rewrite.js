/* exported handler */
function handler(event) {
  var request = event.request;
  // Allow only actual SPA routes. Files, unknown paths and /api keep S3/API statuses.
  if (/^\/(?:appointments|clinicians(?:\/[A-Za-z0-9_-]+)?|clinician\/(?:availability|appointments)|auth\/callback|signed-out)?\/?$/.test(request.uri)) {
    request.uri = '/index.html';
  }
  return request;
}
