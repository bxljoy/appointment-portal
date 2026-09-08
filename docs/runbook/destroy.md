# Destroy and verify the disposable AWS demo

Preserve `.runtime/deployment.json` before deleting deployment roles. It contains
resource IDs and ownership decisions, never credentials. The demo workflow uploads
this sanitized inventory for seven days.

Review exact application targets before deletion:

```text
pnpm demo:destroy -- --dry-run
pnpm demo:destroy -- --force-disposable-secrets
pnpm demo:verify-cleanup
```

Cleanup verifies the STS account before inventory, archives live inventory, writes
the refreshed combined inventory back to `.runtime/deployment.json`, deletes
`AppointmentPortal`, waits for CloudFormation, then refreshes service-specific
paginated inventories. It checks databases, proxies, snapshots and automated
backups; tagged S3 buckets, versions and delete markers; tagged secrets and application
log groups plus `/aws/rds/proxy/appointment-portal-*`; network interfaces and endpoints;
and tagged toolkit ECR/SSM assets. CloudWatch tag checks use each log group's canonical
`logGroupArn`, without the API's trailing `:*` representation. Immediate force deletion applies only
to recorded disposable secrets. Secret values are never read or logged.

Verification exits nonzero for active owned leftovers and unverified blockers.
Stack membership records and richer service records are merged by normalized service
type plus ID/ARN aliases before recovery, so a retained blocker is deleted and waited
for once. Any shared ownership evidence remains a ceiling during that merge.
Outputs identify candidates but do not authorize deletion without exact stack
membership or the live project tag. Interface ENIs remain report-only: cleanup
deletes their owning proxy or VPC endpoint and verifies that the ENI disappears.
Secrets with a deletion date
are reported under `scheduled`, separate from physical removal. An imported GitHub
OIDC provider appears under `shared` and is never deleted.

After evidence is saved, remove project-exclusive delivery and toolkit resources
last, using the selected local AWS profile:

```text
pnpm demo:destroy -- --dry-run --all
pnpm demo:destroy -- --all --force-disposable-secrets
pnpm demo:verify-cleanup -- --all
```

The `--all` path uses authenticated local access to remove the delivery stack,
toolkit stack, then recorded retained
assets. Preserve a provider or toolkit used by another project. If the deletion waiter
fails, cleanup invalidates its pre-delete inventory, reinspects CloudFormation, and
continues blocker recovery only when the live stack status is exactly `DELETE_FAILED`.
Network, authorization, throttling, and other observation errors stop without deleting
residual resources. After a confirmed `DELETE_FAILED`, cleanup inventories fresh,
exact supported project-owned blockers, removes dependent
resources such as an RDS proxy before its database, retries stack deletion once,
and verifies again. It never directly deletes service-owned interface ENIs or a
shared GitHub provider. Secrets deletion is asynchronous; see the official
[DeleteSecret API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html)
(checked 2026-09-06).

For a cancelled GitHub runner, download the demo run's `deployment-manifest`
artifact and run these commands locally. `always()` cannot cover runner loss. The
manual destroy workflow requires the selected successful demo run ID; selecting that
run is the operator's approval of its authenticated deployed commit.
Before requesting AWS credentials or downloading files, `demo:restore-manifest`
queries GitHub's run and artifact metadata with `actions:read` and requires the exact
repository, `.github/workflows/demo.yml`, configured main branch, completed successful
run, head SHA, and unexpired `deployment-manifest`. The destroy workflow always checks
out its own trusted dispatch commit from the configured branch; it never checks out or
executes the candidate demo commit. The trusted helper downloads the exact artifact ID
as raw ZIP bytes, compares those bytes with GitHub's SHA-256 digest, rejects traversal,
symlink, and duplicate ZIP entries, and extracts only root `deployment.json`. It then
binds the parsed manifest's account, region, repository, branch, and commit to the run
provenance. Arbitrary downloaded JSON is never accepted as deletion authority.

Restored `owned:true` records are hints only. Each direct delete requires current
`Project=appointment-portal` tags or fresh membership in a currently owned exact
CloudFormation stack. S3 versions are enumerated only from a live bucket whose current
`Project` tag verifies ownership.
The GitHub OIDC provider remains shared and non-deletable even under `--all`.
Unverified prefix-matching leftovers are reported for manual investigation.
