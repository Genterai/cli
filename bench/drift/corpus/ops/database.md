# Postgres

Postgres holds everything in Beacon that is not a raw check result: accounts, monitors, alert rules, the current state
of every monitor, and billing. Raw results are in ClickHouse (see [Architecture](../engineering/architecture.md)).
Backups and restores have their own page: [Backups](backups.md).

## Clusters

We run Postgres ourselves on EC2, managed by Patroni with etcd for leader election. All clusters run
**PostgreSQL 15.6** with the same configuration template; differences are only in instance size and replica count.

| Cluster | Environment | Region | Nodes | Instance type |
| --- | --- | --- | --- | --- |
| `pg-main-euc1` | production | eu-central-1 | 1 primary, 2 replicas | r6i.2xlarge |
| `pg-main-use2` | production | us-east-2 | 1 primary, 2 replicas | r6i.xlarge |
| `pg-staging` | staging | eu-central-1 | 1 primary | m6i.large |

Replicas are in different availability zones from the primary. Patroni fails over automatically when the primary is
unreachable for 30 seconds.

## Connecting

Services never connect to Postgres directly. They go through PgBouncer, which runs as a sidecar-free deployment in each
cluster in transaction pooling mode.

### Production

- Production PgBouncer listens on port **6543**. The DNS name is `pgbouncer.db.svc.cluster.local` inside the cluster.
- Pool size is 40 server connections per database per PgBouncer pod, with three pods per region.
- Prepared statements are disabled in the services' drivers because of transaction pooling.

### Staging

- The staging pooler listens on port 6432 on `pgbouncer.db.svc.cluster.local` in `nw-staging-euc1`.
- It uses session pooling, so you can use prepared statements and advisory locks when debugging.

### Humans

Engineers get a shell through our CLI, which opens a short-lived tunnel and uses your SSO identity:

```bash
nwctl db shell --env prod --region euc1 --read-only
nwctl db shell --env staging
```

Write access to production needs the `db-writer` role and is logged. Use a transaction and have a second engineer on
the call.

## Configuration highlights

| Setting | Value | Why |
| --- | --- | --- |
| `max_connections` | 400 | PgBouncer keeps the real number much lower |
| `shared_buffers` | 25% of memory | Standard starting point |
| `work_mem` | 32MB | Some reporting queries sort a lot |
| `statement_timeout` | 30s for services | Set per role; migrations run without it |
| `log_min_duration_statement` | 500ms | Slow queries end up in Loki |

## Migrations

Migrations live in `db/migrations/` in the monorepo and run with `goose` as a pre-sync hook during deploys. Rules:

1. Every migration must work with the previous release still running (expand, then contract).
2. Add indexes with `CREATE INDEX CONCURRENTLY`, in their own migration without a transaction.
3. Never rewrite a large table in one statement. Backfill in batches from a job.
4. Changes to `db/migrations/` need review from the Platform team.

## Maintenance

The maintenance window for minor version upgrades and parameter changes that need a restart is Sundays 04:00–05:00 UTC.
Patroni switches over to a replica first, so the impact is a few seconds of connection errors that services retry.

## Monitoring

The "Postgres" dashboard shows replication lag, connections per pool, slow queries and disk usage. Alerts fire on
replication lag above 30 seconds, disk usage above 80%, and failed backups.
