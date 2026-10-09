# Product roadmap 2026

What we plan to build in the second half of 2026, and roughly when. Dates are targets, not promises; customers can be
told the quarter, never the day. The roadmap is reviewed at the start of every month in the product sync.

## Themes

1. **Enterprise readiness.** Larger customers keep asking for the same three things: private probe locations, better
   access control, and audit logs they can export.
2. **Fewer false alarms.** Every false alert costs a customer sleep and costs us trust.
3. **Status pages that customers show off.** Status pages are our best acquisition channel; most new signups have seen
   one first.

## Planned work

| Item | Theme | Target | Status |
| --- | --- | --- | --- |
| Private probe locations (customer-hosted probes) | Enterprise readiness | GA in Q4 2026 | Beta with four customers |
| SAML SSO on the Team plan | Enterprise readiness | Q3 2026 | In progress |
| Audit log export to S3 and Datadog | Enterprise readiness | October | Design |
| Multi-step API checks | Fewer false alarms | November | In progress |
| Smarter retries for flaky targets | Fewer false alarms | September | Done, rolling out |
| Custom domains for status pages | Status pages | Early access in September | In progress |
| Status page subscriber digests | Status pages | December | Not started |
| Terraform provider v2 | Developer experience | August | Done |

## Private probe locations

Customers run a small probe agent inside their own network and assign monitors to it, so they can monitor internal
services without opening them to the internet. The agent is a single static binary or a container image. It connects
outwards to Beacon over HTTPS; nothing connects in.

Open questions before GA:

- How we price it (per location, or per check run).
- How long we keep results from private locations; some customers want them only in their own region.
- Whether agents auto-update or are pinned by the customer.

## Not on the roadmap

These come up often and are deliberately not planned this year:

- A mobile app. Push notifications through PagerDuty and Opsgenie cover the need for now.
- Real-user monitoring (RUM). A different product with different competitors.
- Log monitoring. Same reason.

## How to propose something

Write a one-page problem statement in Linear under the "Product ideas" project: who has the problem, how often, and what
they do today. Do not start with the solution. The Head of Product, Lena Vogel, reviews new ideas every two weeks.
