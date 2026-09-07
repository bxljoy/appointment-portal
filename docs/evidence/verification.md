# AWS verification evidence

Status: **not executed**. This file is a schema for the disposable deployment run;
it is not evidence that AWS behavior passed.

After a real deployment, copy only the sanitized fields from
`.runtime/verification.json`: deployed commit, UTC check time, scenario status, and
allowlisted request IDs. Never copy tokens, email addresses, credential paths,
CloudWatch log bodies, or browser storage. The following checks must all pass before
changing the status to verified:

- managed Cognito authorization-code login with PKCE, logout, and return navigation;
- access-token use, ID-token rejection, malformed/missing token rejection, missing
  custom scope rejection, and real five-minute access-token expiry;
- caller isolation, forged identifier rejection, one-winner booking concurrency,
  cancellation reopening, and clinician cancel-withdraw;
- uncached CloudFront API responses, protected direct API Gateway, private S3,
  nested SPA refresh, and non-HTML missing-asset behavior;
- one manual self-registration, email verification, initial patient role, sign-out,
  sign-in, and password recovery with a controlled inbox.

The manual registration line must be entered as `manual-passed` only after a person
has completed the email steps. Automated provisioned-account tests cannot populate it.
