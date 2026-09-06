# Public RDS trust bundle

`rds-global-bundle.pem` contains public CA certificates, never a private key.
It was retrieved over verified HTTPS on 2026-09-06 from
[AWS's public RDS trust store](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem),
linked by the [RDS TLS documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

SHA-256: `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`.

CDK copies this file into each feature Lambda at `certs/rds-global-bundle.pem`.
Those functions connect only to the proxy and use Node's standard trust store for
the proxy's ACM-issued certificate chain. The bundled RDS roots are also available
for the explicit direct-database migration boundary added in Task 14; they do not
grant or enable direct database access. Keep the file and provenance together when
reviewing a future AWS CA rotation, and rerun the actual CDK asset checks.
