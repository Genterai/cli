# Production deploys

How a backend release gets to production, how we watch it, and how we roll it back. The weekly rhythm and versioning are
in [Release process](../engineering/release-process.md). Staging works differently; see [Staging](deploy-staging.md).

## Overview

Production runs in two EKS clusters: `nw-prod-euc1` (Frankfurt, deployed first) and `nw-prod-use2` (Ohio, deployed
second). Argo CD syncs each cluster from the `deploy/prod/` folder of the `beacon-deploy` repository. A deploy is a pull
request that changes image tags in that folder; nobody runs `kubectl apply` against production by hand.

## Who can deploy

- The release captain, for the weekly release.
- Any engineer with the `prod-deployer` role, for hotfixes, with a second engineer watching.
- Platform on-call, for rollbacks, at any time and without asking.

## Steps

1. Check #incidents. Do not deploy during an open SEV1 or SEV2 unless the deploy is the fix.
2. Run the promotion script from the release branch:

   ```bash
   ./scripts/promote.sh release/2026.08.3 --env prod
   ```

   It opens a pull request in `beacon-deploy` with the new image tags for both regions.
3. Get one approval from another engineer with the `prod-deployer` role, then merge.
4. Argo CD starts the canary in Frankfurt. Watch the "Release health" dashboard and #deploys.
5. When Frankfurt is fully rolled out and healthy, Argo CD continues with Ohio automatically.
6. Post "done" in the release thread in #deploys.

## Canary

Every service rolls out with Argo Rollouts. The canary takes 10% of traffic first and **bakes for 25 minutes** while
automated analysis compares error rate, latency and check-result volume with the stable version. If any metric is
outside its threshold, the rollout aborts and traffic goes back to the stable version without anyone pressing a button.

After the bake, traffic moves to 50% for five minutes and then to 100%.

## Deploy windows

| Day | Window |
| --- | --- |
| Monday to Thursday | 09:00–18:00 CET |
| Friday | 09:00 until the weekend cutoff |
| Saturday, Sunday, public holidays in the Netherlands | No deploys |

The weekend cutoff is **16:00 CET** on Fridays: nothing goes to production after that until Monday morning, except
rollbacks and fixes for an ongoing incident. From December 18 until January 2 there is a change freeze; exceptions need
approval from the VP Engineering.

## Rolling back

Rolling back is always allowed and never needs an approval.

```bash
argocd app rollback beacon-api-prod-euc1   # previous revision
argocd app history beacon-api-prod-euc1    # pick an older one
```

After a rollback, revert the image tags in `beacon-deploy` too, or Argo CD will roll forward again on the next sync.
Then open an incident if customers were affected.

## Database migrations

Migrations run as a pre-sync hook before the new pods start. They must be backwards compatible with the previous
release, because during the canary both versions run at the same time. Destructive changes (dropping a column) happen in
a later release, after the code that used the column is gone. See [Database](database.md).

## After the deploy

- Keep an eye on #beacon-alerts for an hour.
- Check the customer-facing changelog was published.
- If anything looked odd during the canary, write it in the release thread, even if the rollout passed.
