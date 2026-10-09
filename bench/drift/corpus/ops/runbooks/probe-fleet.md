# Runbook: probe fleet

Use this runbook when checks are late, when one probe location reports far more failures than the others, or when the
`ProbeLocationUnhealthy` or `ChecksLate` alerts fire.

## Background

Probe workers run in 11 locations. Each location has its own small Kubernetes cluster (or, for Hetzner and Vultr, a
k3s cluster) that runs the `probe-worker` deployment. Workers pull jobs for their location from the scheduler and
publish results back to the central results stream.

All commands below assume your context points at the right location cluster and namespace:

```bash
nwctl kube use probes --location fra1
kubectl config set-context --current --namespace=beacon-probes
```

## Symptoms and first checks

| Symptom | Likely cause | First check |
| --- | --- | --- |
| Checks late everywhere | Scheduler or results stream problem | Results pipeline dashboard; see the queue backlog runbook |
| Checks late in one location | Workers crashing or starved | `kubectl get pods -o wide` in that location |
| Many failures from one location only | Network trouble near the location | Compare with other locations in the Probe fleet dashboard |
| Failures for one target from all locations | The customer's site is really down | Nothing to do; that is Beacon working |

## Workers are crashing

```bash
kubectl get pods -l app=probe-worker
kubectl logs -l app=probe-worker --tail=200 | grep -i panic
kubectl rollout restart deploy/probe-worker
```

If restarts do not help and the last deploy changed `probe-worker`, roll back that location first (Argo CD app
`probe-worker-<location>`), then the others.

## A location has network trouble

When a provider has routing problems, one location reports timeouts for targets that are fine. Beacon's confirmation
logic stops most false alerts, but customers still see red dots in their check history.

1. Confirm in the Probe fleet dashboard that failures are concentrated in one location.
2. Drain the location so the scheduler stops sending it jobs:

   ```bash
   nwctl probes drain --location fra1 --reason "Upstream routing issue, provider ticket 88213"
   ```

3. Post in #beacon-platform and, if it lasts more than 30 minutes, add a note on the public status page.
4. Undrain when the provider confirms the fix and the location's failure rate is back to normal:

   ```bash
   nwctl probes undrain --location fra1
   ```

Never drain more than three locations at once; the scheduler refuses, because monitors need enough locations to confirm
outages.

## Capacity

Each worker handles about 400 concurrent checks. The horizontal pod autoscaler scales on queue time, between 4 and 40
pods per location. If a location is pinned at its maximum, raise it in `deploy/probes/<location>/values.yaml` and tell
the Probes team.

## Escalation

If the problem is not in the probe fleet itself, hand over to the owning team: scheduler and ingester belong to Probes,
NATS and the clusters to Platform.
