# Monitoring our own systems

Beacon monitors other people's systems; this page is about how we monitor Beacon itself. It covers metrics, logs,
dashboards and how alerts reach people.

## Stack

| Piece | What we use | Where |
| --- | --- | --- |
| Metrics | Prometheus, one per cluster | In-cluster, 15 days of raw samples |
| Long-term metrics | Thanos (sidecar, store, compactor) | S3 bucket per region |
| Logs | Loki | 14 days |
| Traces | Tempo, sampled at 5% | 7 days |
| Dashboards | Grafana | `grafana.nwl.internal`, sign in with SSO |
| Alerting | Alertmanager | One per cluster, clustered |

We also run Beacon against itself: the dashboard, the API and every status page are monitored from the production probe
fleet, plus an external check from a competitor's free tier, in case our own fleet is the thing that is down.

## Long-term retention

Thanos compacts and downsamples everything older than 40 hours. Raw resolution is kept for 30 days, 5-minute
downsamples for 90 days, and 1-hour downsamples for **13 months**, which is enough for year-over-year capacity planning.

## Dashboards

Dashboards are provisioned from the `dashboards/` folder in `beacon-deploy`; changes made in the Grafana UI are lost on
the next sync. The most used ones:

- **Release health**: error rate, latency and result volume per service and version. Used during deploys.
- **Probe fleet**: checks run per location, queue time, failure rate per location.
- **Results pipeline**: stream lag, ingester throughput, ClickHouse insert latency.
- **Postgres**: replication lag, pool usage, slow queries.

## Writing alerts

Alert rules live next to the service in `deploy/alerts/<service>.yaml`. Every rule needs:

- a `severity` label (`page`, `warn` or `info`),
- a `runbook_url` annotation that points to a page in `ops/runbooks/`,
- a `summary` that a tired person can understand at 3 a.m.

Alert on symptoms customers feel (checks late, alerts not sent) rather than on causes (CPU high). Cause-based alerts are
fine as `warn`.

## Alert routing

| Severity | Goes to | When |
| --- | --- | --- |
| `page` | PagerDuty: the rotation that is on shift | Any time |
| `warn` | Slack `#beacon-alerts-low` | Working hours; nobody is woken up |
| `info` | Nowhere; visible in Grafana and Alertmanager only | |

Alertmanager groups alerts by service and region, and waits 30 seconds before sending the first notification of a group
so that one problem produces one page.

## Silences

Silence an alert only with an end time and a comment that says why and who. Silences longer than 24 hours need a Linear
issue linked in the comment. The weekly on-call handover reviews all active silences.

## Logs

Services log JSON to stdout. Include `account_id` and `monitor_id` when you have them; never log tokens, passwords or
the bodies of customers' HTTP responses. Query logs in Grafana's Explore view with LogQL.
