# Staging

Staging is where every change runs before it reaches customers. It is deliberately boring: one cluster, synthetic
customers, and data that is thrown away every night. Production deploys are in [Production deploys](deploy-production.md).

## What staging is

- One EKS cluster, `nw-staging-euc1`, in Frankfurt. There is no US staging.
- The dashboard and the API are served from `staging.beacon-nwl.dev`, behind Google sign-in. The API is under `/api`.
- Probe workers run in three locations only (Frankfurt, Ohio and a Hetzner box in Helsinki).
- Alerts from staging go to Mailpit and to the `#staging-alerts` channel, never to real customers.

## How deploys work

Staging deploys itself. Every merge to `main` builds new images, and Argo CD syncs the `deploy/staging/` folder of
`beacon-deploy` within about five minutes. The weekly release branch replaces `main` on staging during its soak, then
staging goes back to following `main`.

- No approvals, no deploy windows, no canary.
- Deploys can happen at any time, including weekends.
- If you need staging to stay on a specific version (for a demo, or to reproduce a bug), pin it:

  ```bash
  ./scripts/pin-staging.sh beacon-api 2026.08.2
  ./scripts/pin-staging.sh --clear beacon-api
  ```

  Pins expire after 48 hours so nobody forgets one.

## Nightly reset

Staging data is not precious. Every night at **03:15 UTC** a job drops the staging Postgres and ClickHouse databases and
reseeds them from the fixtures in `dev/fixtures/`. The reset takes about ten minutes; the API returns `503` while it
runs.

If you are testing something that must survive a night, create it again in the morning or ask in #beacon-platform to
skip one reset.

## Test accounts

| Account | Plan | Use it for |
| --- | --- | --- |
| `acme-free@staging` | Free | Limits and upgrade prompts |
| `acme-team@staging` | Team | Most manual testing |
| `acme-enterprise@staging` | Enterprise | SSO, audit log, private locations |

Passwords are in 1Password ("Staging test accounts").

## QA regression

QA runs the regression suite against staging every day between 13:00 and 15:00 CET. Avoid pinning or restarting
services during that window, or the results are useless.

## Differences from production

- Smaller instances and single replicas; performance numbers from staging mean little.
- No Cloudflare in front; rate limits are the API's own.
- Feature flags are evaluated against the staging environment of the flag tool.
- The billing service talks to Stripe in test mode.

## When staging is broken

Staging problems are not incidents. Post in #beacon-platform with what you saw; the Platform team looks at it during
working hours. Do not page anyone for staging.
