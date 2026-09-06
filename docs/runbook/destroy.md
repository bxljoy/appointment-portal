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
backups; tagged S3 buckets, versions and delete markers; tagged secrets and log
groups; network interfaces and endpoints; and tagged toolkit ECR/SSM assets. Immediate force deletion applies only
to recorded disposable secrets. Secret values are never read or logged.

Verification exits nonzero for active owned leftovers and unverified blockers.
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
assets. Preserve a provider or toolkit used by another project. If deletion fails,
cleanup inventories exact supported project-owned blockers, removes dependent
resources such as an RDS proxy before its database, retries stack deletion once,
and verifies again. It never directly deletes service-owned interface ENIs or a
shared GitHub provider. Secrets deletion is asynchronous; see the official
[DeleteSecret API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html)
(checked 2026-09-06).

For a cancelled GitHub runner, download the demo run's `deployment-manifest`
artifact and run these commands locally. `always()` cannot cover runner loss.
