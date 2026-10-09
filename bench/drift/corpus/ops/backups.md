# Backups and restores

What we back up, where it goes, how long we keep it, and how to get it back. If you are restoring production data
because of an incident, read the whole page first and tell the incident commander before you start.

## What is backed up

| Data | Method | Frequency | Retention |
| --- | --- | --- | --- |
| Postgres (all production clusters) | Base backup plus continuous WAL archiving | Nightly base backup at 01:00 UTC | 35 days |
| ClickHouse raw results | `clickhouse-backup` to S3 | Weekly full, daily incremental | 8 weeks |
| S3 buckets (exports, status page assets) | Versioning and cross-region replication | Continuous | 90 days for old versions |
| Redis | Not backed up | | Rebuilt from Postgres if lost |
| Staging | Not backed up | | Reset nightly anyway |

## Postgres

Base backups and WAL archiving are handled by **pgBackRest**, which runs on every Patroni node and pushes to the
`nwl-pg-backups-euc1` and `nwl-pg-backups-use2` buckets. Backups are encrypted with a KMS key per region, and each
bucket has Object Lock so a compromised account cannot delete them.

Because WAL is archived continuously, we can restore to any point in time within the retention window, usually with a
loss of under a minute of data.

### Checking backup health

```bash
nwctl backups status --env prod
```

This shows the last successful base backup per cluster, WAL archive lag, and the size of the repository. An alert fires
when the last base backup is older than 26 hours or the WAL archive is more than 15 minutes behind.

## Restoring Postgres

Restores never overwrite a running production cluster. You restore into a new cluster, check it, and then switch
services over (or copy the rows you need).

1. Open an incident or a change ticket, and say what point in time you need.
2. Create a restore cluster from the backup:

   ```bash
   nwctl backups restore --env prod --region euc1 --target-time "2026-08-14 09:30:00+00" --into pg-restore-1
   ```

3. Verify the data on the restore cluster with a read-only shell.
4. Either copy the rows you need back with a reviewed script, or fail over the services to the restore cluster
   following the Patroni runbook.
5. Delete the restore cluster when you are done; it costs real money.

## ClickHouse

ClickHouse backups exist so that we can rebuild after losing a whole shard. Restoring a single customer's results is not
supported; results are not critical enough to justify it.

## Restore drills

Platform runs a restore drill every month: a random production backup is restored into a scratch cluster, and a script
compares row counts and checksums with production. The result is posted in #beacon-platform. Two failed drills in a row
is treated as a SEV3 incident.

## Who can restore

Restores need the `backup-operator` role, which Platform engineers and the on-call primary have. Access to the backup
buckets themselves is limited to the backup tool's role and a break-glass role.
