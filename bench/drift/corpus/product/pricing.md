# Pricing and plans

The source of truth for what each Beacon plan includes and costs. The public pricing page is generated from the plan
definitions in the billing service; if this page and the billing service disagree, the billing service wins and this
page needs a fix.

## Plans

| | Free | Starter | Team | Business | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Price, billed monthly | $0 | $24/month | $79/month | $299/month | Custom |
| Price, billed yearly | $0 | $240/year | $790/year | $2,990/year | Custom |
| Monitors included | 5 monitors | 20 monitors | 100 monitors | 500 monitors | From 1,000 monitors |
| Shortest check interval | 5 min | 1 min | 30 s | 30 s | 10 s |
| Probe locations per monitor | 3 | 5 | All public | All public | All public plus private |
| Check history in the dashboard | 30 days | 90 days | 1 year | 1 year | Contractual |
| Status pages | 1 | 1 | 3 | 10 | Unlimited |
| Team members | 1 | 3 | 10 | 30 | Unlimited |
| SMS and voice alerts | No | 50 credits/month | 200 credits/month | 1,000 credits/month | Custom |
| SSO (SAML) | No | No | No | Yes | Yes |
| Support | Help center | Email | Email | Email, priority | Dedicated, with SLA |

Yearly billing gives two months free. Prices are in US dollars; customers in the EU are billed in euros at the same
numbers (so $79 becomes €79), plus VAT where it applies.

## Trials

New accounts get a 14-day trial of the Team plan without a credit card. At the end of the trial they drop to Free unless
they pick a plan. Sales can extend a trial once by another 14 days from the admin panel.

## Add-ons

- **Extra monitors**: packs of 50 for $20/month on Team and Business.
- **SMS and voice credits**: $10 per 100 credits. Credits do not expire while the subscription is active.
- **Extra status pages**: $9/month each.
- **Private probe locations**: Enterprise only, priced per location.

## Limits and what happens when you hit them

- A workspace at its monitor limit cannot create new monitors; existing ones keep running.
- When SMS credits run out, alerts fall back to email and the account owner gets a warning.
- Over-limit team members are not removed; the workspace is asked to upgrade or remove someone.

## Discounts

- Non-profits and open-source projects: 50% off Starter or Team, on request, verified by Sales.
- Education: Team for free for courses, one semester at a time.
- Anything else goes through the discount approval rules in the [Sales playbook](../sales/playbook.md).

## Changing prices

Price changes for existing customers need 60 days' notice by email. New prices apply from the next renewal after the
notice period. Grandfathering decisions are made by the CEO and the Head of Product together.

## Where the numbers come from

Plan limits live in `services/billing/plans.yaml`. Changing a limit there changes it in the product on the next deploy,
so changes to that file need approval from Product and Revenue engineering.
