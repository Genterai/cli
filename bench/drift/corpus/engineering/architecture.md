# Beacon architecture

This page describes how Beacon is put together: the services, how a check travels through the system, where data lives
and which regions we run in. It is meant for new engineers and for anyone writing a design doc. Operational detail
(ports, commands, dashboards) lives in the `ops/` pages.

## Services

| Service | Language | Owner | What it does |
| --- | --- | --- | --- |
| `beacon-api` | Go | Core API | Public REST API and the backend of the dashboard |
| `web` | TypeScript (Next.js) | Web | Dashboard and public status pages |
| `scheduler` | Go | Probes | Turns monitor definitions into check jobs on a fixed cadence |
| `probe-worker` | Go | Probes | Runs checks from a probe location and reports results |
| `ingester` | Go | Probes | Stores results and decides whether a monitor changed state |
| `notifier` | Go | Core API | Sends alerts to channels (email, Slack, SMS, webhooks, ...) |
| `billing` | Go | Revenue engineering | Plans, invoices, usage metering, Stripe integration |

All Go services live in the `beacon` monorepo; the web app lives in `beacon-web`. Every service ships as a container
image and runs on Kubernetes (EKS), deployed with Argo CD.

## Life of a check

1. A customer creates a monitor. `beacon-api` stores it in Postgres.
2. The `scheduler` reads monitor definitions every few seconds and emits a check job for each monitor that is due, one
   job per probe location the monitor is assigned to.
3. A `probe-worker` in that location picks up the job, runs the check (HTTP request, TCP connect, DNS lookup, ...) and
   publishes the result to the `RESULTS` stream on **NATS JetStream**.
4. The `ingester` consumes the stream, writes every raw result to ClickHouse, and keeps the current state of each
   monitor in Postgres.
5. When the state changes, the `ingester` emits an event that the `notifier` turns into alerts according to the
   customer's alert rules.

Jobs and results are small (under 2 KB each). At peak we process about 14,000 results per second across all regions.

## Confirming an outage

A single failed check never pages a customer. A monitor is marked **Down** only when the failure is confirmed from
at least two probe locations within the same check cycle. If only one location fails, the monitor goes to **Degraded**
and we re-check from a third location straight away. This removes most false alarms caused by a bad network path near
one location.

Heartbeat monitors work the other way round: there is no probe, and the monitor goes Down when the expected ping does
not arrive within the grace period the customer configured.

## Data stores

| Store | What lives there | Notes |
| --- | --- | --- |
| Postgres | Accounts, monitors, alert rules, current state, billing | Patroni clusters, see [Database](../ops/database.md) |
| ClickHouse | Raw check results and aggregates | Partitioned by month; retention in [Data retention](../security/data-retention.md) |
| Redis | Rate limiting, alert de-duplication, short-lived locks | Sentinel setup, nothing durable |
| S3 | Backups, exports, status page assets | Versioned buckets |

## Regions

- **eu-central-1 (Frankfurt)** is the home region. Accounts, billing and the control plane live here.
- **us-east-2 (Ohio)** runs a second data plane for customers who chose US data residency.
- Probe workers run in 11 locations across AWS, Hetzner and Vultr, so that a single provider outage does not blind us.

Customers choose a data region at signup. Their monitors, results and alerts never leave that region; only aggregated
billing usage is sent to Frankfurt.

## Third parties

- **Stripe** for payments and invoices.
- **Twilio** for SMS and voice alerts.
- **Postmark** for transactional email.
- **Cloudflare** in front of the dashboard, the API and status pages.

## Design docs

Bigger changes start with a design doc in `engineering/` using the template in the monorepo. Link it from the Linear
project and ask for comments in #eng-design. A design doc is accepted when the owning team lead and one other lead
approve it.
