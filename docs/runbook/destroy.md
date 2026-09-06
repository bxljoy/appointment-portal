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

Cleanup verifies the account, archives live inventory, deletes
`AppointmentPortal`, waits for CloudFormation, then refreshes service-specific
paginated inventories. It checks databases, proxies, snapshots and automated
backups; S3 versions and delete markers; recorded secrets; log groups; network
interfaces and endpoints; and toolkit assets. Immediate force deletion applies only
to recorded disposable secrets. Secret values are never read or logged.

Verification exits nonzero for active owned leftovers. Secrets with a deletion date
are reported under `scheduled`, separate from physical removal. An imported GitHub
OIDC provider appears under `shared` and is never deleted.

After evidence is saved, remove project-exclusive delivery and toolkit resources
last, using the selected local AWS profile:

```text
pnpm demo:destroy -- --dry-run --all
pnpm demo:destroy -- --all --force-disposable-secrets
pnpm demo:verify-cleanup -- --all
```

The `--all` path removes the delivery stack, toolkit stack, then recorded retained
assets. Preserve a provider or toolkit used by another project. If deletion fails,
inspect CloudFormation events and the exact residual instead of repeatedly deleting
or broadening selection. Secrets deletion is asynchronous; see the official
[DeleteSecret API](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_DeleteSecret.html)
(checked 2026-09-06).

For a cancelled GitHub runner, download the demo run's `deployment-manifest`
artifact and run these commands locally. `always()` cannot cover runner loss.
