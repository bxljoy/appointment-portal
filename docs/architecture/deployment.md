# Disposable deployment and database boundaries

The CDK application is in `infra/`. It provisions the private data foundation;
identity, API functions, migrations, frontend publication, and lifecycle commands
are added by subsequent implementation tasks. No deployment is performed by tests.

## Configuration and offline synthesis

`PortalConfig` validates a concrete 12-digit account, AWS region name, explicit
PostgreSQL 17 minor version, `bootstrap` or `ready` phase, and a 1–10 character
alphanumeric CDK bootstrap qualifier. The stack environment must match that account
and region. `ready` requires `frontendUrl`, a public HTTPS origin without a trailing
slash, path, credentials, query, or fragment. The default deployment region in the
approved design is `eu-north-1`; actual engine support remains a preflight check.
The test value `17.6` is a fixture, not a claim about current regional availability.

The CDK entrypoint reads `account`, `region`, `postgresVersion`, `phase`, `qualifier`,
and optional `frontendUrl` from CDK context. Nothing infers a deployment account or
silently changes the phase. The synthesizer uses the configured qualifier; the
corresponding bootstrap stack is separately inventoried and is not created here.

Run `pnpm test infra/test/data.test.ts infra/test/config.test.ts` from the root.
Tests synthesize both phases with fake account `111111111111`, region `eu-north-1`,
and the cached CDK context key
`availability-zones:account=111111111111:region=eu-north-1` containing
`["eu-north-1a", "eu-north-1b"]`. They assert that no context lookups remain.
`pnpm --filter @portal/infra typecheck` checks the infrastructure types;
`pnpm --filter @portal/infra synth` runs the CDK CLI with `--no-lookups` and requires
explicit context, including previously verified AZ context for the target account.
Keep account-specific `cdk.context.json` untracked.

## Network and credentials

The VPC has two isolated `/24` subnets, no NAT or internet gateway, and no public
database. Five dedicated security groups allow only these initiated connections:

| Source | Destination | TCP port |
| --- | --- | --- |
| API functions | RDS Proxy | 5432 |
| RDS Proxy | PostgreSQL | 5432 |
| Migration function | PostgreSQL | 5432 |
| API functions | Secrets Manager interface endpoint | 443 |
| Migration function | Secrets Manager interface endpoint | 443 |

The endpoint uses private DNS and does not admit the whole VPC CIDR. Its network
policy is supplemented by narrowly scoped secret IAM permissions on execution
roles. The default VPC security group is unused; CDK's optional default-group cleanup
custom resource is disabled to avoid adding a privileged Lambda. Every workload
must explicitly use its dedicated group. Database and endpoint outbound rules use
CDK's impossible ICMP sentinel to prevent EC2's implicit allow-all egress default.

Two Secrets Manager resources independently generate 32-character passwords for
`portal_admin` and `portal_app`. Only the admin secret is attached to the database
instance; RDS Proxy receives exactly one secret according to deployment phase:

1. **Bootstrap:** the proxy authenticates with the admin secret so its target can
   become healthy before `portal_app` exists. This is a temporary provisioning state.
   API functions must never receive the admin secret ARN or read permission, in
   either phase. Browser verification and frontend publication must not run yet.
2. **Provision:** the privileged migration function connects directly to RDS using
   the admin credential, creates the schema and least-privilege `portal_app` role,
   and assigns that role the password from the application secret (Task 14).
3. **Ready:** redeploy with `phase=ready` and the deployed frontend HTTPS origin.
   Proxy authentication and its IAM policy change to the application secret alone.
   Confirm proxy target health and application access before browser verification
   or publication (Task 17). Never use a ready proxy as evidence that provisioning
   ran; the phase value alone cannot prove the database role exists.

The API adapter expects `APPLICATION_DATABASE_SECRET_ARN` to refer to the application
secret, `DATABASE_HOST` to the proxy endpoint, `DATABASE_NAME=portal`, and
`DATABASE_PORT=5432`. It rejects a username other than `portal_app`. The application
secret deliberately contains only username and password; explicit connection
environment values prevent accidentally selecting the administrator's direct RDS
endpoint. Proxy connections verify TLS using Node's standard trust store; direct
RDS migration connections require the RDS CA bundle. Normal runtime never migrates.

RDS Proxy requires TLS, disables debug SQL logging, and uses connection percentages
60 maximum / 30 idle with a five-second borrow timeout. The database is an encrypted
20 GiB gp3 `db.t4g.small` PostgreSQL 17 instance, single AZ, without storage autoscaling.

## Removal behavior

All stack resources have explicit `Delete` deletion and replacement policies;
taggable resources carry `Project=appointment-portal`. Database deletion protection
is disabled, automated backup retention is zero, automated backups are deleted,
and deletion takes no final snapshot. This is deliberate for fictional demo data.

CloudFormation deletes Secrets Manager secrets using `ForceDeleteWithoutRecovery`
under its normal Delete behavior, so these secrets do not have a recovery window.
Actual permanent deletion is asynchronous. Teardown must inventory resources and
verify disappearance, recording any pending deletion rather than treating successful
stack destruction as proof. See [CloudFormation deletion policies](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-deletionpolicy.html)
and the [Secrets Manager deletion API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html).
Shared CDK bootstrap resources remain outside this application stack and must be
preserved unless separately verified as project exclusive.
