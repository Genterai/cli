# Northwind Labs internal docs

This repository is the single source of truth for how Northwind Labs builds, sells and runs **Beacon**, our hosted
uptime-monitoring service. If something here is wrong, fix it in a pull request. If you are not sure who owns a page,
ask in #docs and someone will point you to the right team.

## Layout

| Folder | What lives there | Owner |
| --- | --- | --- |
| `handbook/` | Company basics: time off, expenses, travel, onboarding, the office | People Ops |
| `engineering/` | How we write, test, review and release code | Engineering leads |
| `ops/` | Production: deploys, on-call, databases, monitoring, runbooks | Platform team |
| `product/` | Pricing, roadmap, positioning | Product |
| `sales/` | Sales playbook and campaigns | Revenue |
| `security/` | Access, vulnerabilities, data retention | Security |
| `support/` | Customer support processes | Support |

## Conventions

- One topic per page. If a page grows past roughly 150 lines, split it.
- Every page starts with a `#` title. Use `##` for sections and `###` sparingly.
- Put commands in fenced code blocks so they can be copied without editing.
- Dates are written as `YYYY-MM-DD`. Times always carry a zone (CET, UTC, ET).
- Never paste secrets. Link to the 1Password item instead.
- When a page is replaced, do not delete it right away. Add a deprecation notice at the top that links to the new page,
  and delete the old one after a quarter.

## Frequently used pages

- New here? Start with [Welcome](handbook/welcome.md) and [Onboarding](handbook/onboarding.md).
- Shipping code: [Code review](engineering/code-review.md), [Release process](engineering/release-process.md).
- Being on call: [EU rotation](ops/oncall-eu.md), [US rotation](ops/oncall-us.md),
  [Incident response](ops/incident-response.md).
- Touching production data: [Database](ops/database.md), [Backups](ops/backups.md).
- Talking to customers about money: [Pricing](product/pricing.md), [Sales playbook](sales/playbook.md).

## Reviews

Pages in `ops/` and `security/` need a review from the owning team before merge. Everything else can be merged by the
author after one approval from anyone. Typos and broken links can be fixed without review.

## Abbreviations

| Abbreviation | Meaning |
| --- | --- |
| EUC1 | AWS eu-central-1 (Frankfurt) |
| USE2 | AWS us-east-2 (Ohio) |
| PD | PagerDuty |
| IC | Incident commander |
| PIR | Post-incident review (our word for a postmortem) |
| ARR | Annual recurring revenue |
| AE | Account executive |
