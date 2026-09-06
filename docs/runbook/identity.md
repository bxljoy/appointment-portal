# Cognito identity deployment ordering

The disposable portal uses a Cognito Essentials user pool with newer managed login,
verified email registration, email recovery, and optional authenticator-app MFA.
The public SPA app client requests exactly `openid profile portal/access` through
authorization code flow with PKCE (the browser config enables PKCE). Access tokens
last five minutes and refresh tokens one day. No identity pool, client secret, SMS
role, or custom email delivery integration is required.

The deployment workflow must preserve this order:

1. Only for a new environment, deploy `phase=bootstrap`. Cognito permits the local
   callback `http://localhost:5173/auth/callback` and logout
   `http://localhost:5173/signed-out`. Obtain the frontend origin from deployment
   outputs when the web resources are available.
2. Complete database initialization, then deploy `phase=ready` with `frontendUrl`
   set to that literal HTTPS origin (for example `https://demo.cloudfront.net`).
   Config rejects missing origins, HTTP, paths, credentials, query strings, fragments,
   and CloudFormation tokens. The client adds `/auth/callback` and `/signed-out`
   URLs under the deployed origin while keeping the local URLs.
3. Generate the frontend public config from the same deployment's pool issuer,
   client ID, Cognito domain, and frontend origin. Publish only after the ready
   update succeeds. Follow the field contract in [local.md](local.md).

For an existing ready environment, always deploy directly with `phase=ready` and its
saved frontend origin, including retries. Never fall back to bootstrap when the
origin cannot be read: stop and recover the deployment outputs first. The future
deployment runner must enforce this using the existing stack state; synthesis is
offline and cannot determine the state of a previously deployed environment.

Identity constructs keep the same logical IDs across phases. Callbacks use literal
origins rather than CloudFront references, preventing a dependency cycle when the
API authorizer and distribution are added. The app client explicitly depends on
the resource server, and managed branding depends on the domain and client.
The domain prefix hashes project/account/region/bootstrap qualifier into a bounded,
deterministic suffix; keep those deployment inputs stable. The pool and all related
resources inherit the project's destructive removal/replacement policies.

Offline assertions prove template configuration and phase stability. Actual managed
login, MFA enrollment, email delivery and verification, and token/logout journeys
remain deployment acceptance checks. Use controlled email accounts and fictional data.
