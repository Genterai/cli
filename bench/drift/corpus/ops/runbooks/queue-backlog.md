# Runbook: results backlog

Use this runbook when the `ResultsBacklogHigh` alert fires, or when customers report that their check history or alerts
are minutes behind. A backlog means probe workers are producing results faster than the ingester is writing them.

## Background

Probe workers publish every result to the `RESULTS` stream. The `ingester` deployment reads it through the durable
consumer `ingester`, writes raw results to ClickHouse in batches, and updates monitor state in Postgres. Alerts are
evaluated after the write, so a backlog delays alerts too. That is why this alert pages.

## Check the lag

```bash
nwctl kube use prod --region euc1
nats --context prod-euc1 consumer info RESULTS ingester
```

Look at `Unprocessed Messages` and `Ack Pending`. The Results pipeline dashboard shows the same numbers over time,
together with ClickHouse insert latency.

## Common causes

| Cause | How it looks | What to do |
| --- | --- | --- |
| ClickHouse inserts slow | Insert latency up, ingester CPU low | Check merges and disk on ClickHouse; see below |
| Ingester pods crashing | Restarts in `kubectl get pods`, lag grows in steps | Logs, then roll back the last ingester deploy |
| Burst after a drained location comes back | Lag spikes once, then falls | Usually clears itself; scale up if it does not |
| One noisy account | Results per second jumps for one `account_id` | Throttle the account (below) |

## Scale the ingester

The ingester scales on lag automatically, but the autoscaler is conservative. During a backlog you can scale by hand:

```bash
kubectl -n ingest scale deploy/ingester --replicas=16
```

The hard cap is **24 replicas**. Above that, ClickHouse receives more parallel inserts than it can merge, and the backlog
gets worse, not better. If 24 is not enough, the problem is ClickHouse, not the ingester.

## ClickHouse is the bottleneck

- Check `system.merges` and `system.parts` for tables with thousands of active parts. Too many parts means inserts are too
  small; raise the ingester batch size (`INGEST_BATCH_ROWS`) temporarily.
- Check disk usage on every ClickHouse node. Merges stop when a disk is nearly full.
- Hand over to the Platform team if a ClickHouse node is unhealthy.

## Throttle a noisy account

```bash
nwctl accounts throttle acc_3jd92 --results-per-second 200 --duration 2h
```

Tell Support before you do this; the customer will see delayed results.

## After the backlog clears

- Check that alerts for the delayed period were sent (the notifier catches up on its own, but verify a few).
- If the lag was above 10 minutes, it counts as a SEV2; make sure an incident exists.
- Scale the ingester back to automatic: `kubectl -n ingest annotate deploy/ingester autoscaling/manual-`.
