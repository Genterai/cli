# Welcome to Northwind Labs

Northwind Labs makes **Beacon**, a hosted uptime-monitoring service used by about 2,300 teams to watch their websites,
APIs, scheduled jobs and TLS certificates. We were founded in 2019 in Rotterdam and are now around 40 people spread over
nine countries, with most of the company in Europe and a small group in the United States.

This page is the short version of who we are and how we work. The rest of the handbook goes into detail.

## What Beacon does

- Runs HTTP, TCP, ICMP, DNS and certificate-expiry checks from probe locations around the world.
- Accepts heartbeats from customers' cron jobs and raises an alert when one goes missing.
- Sends alerts to email, Slack, Microsoft Teams, PagerDuty, Opsgenie, SMS and webhooks.
- Publishes public status pages that customers link to from their own sites.

## Teams

| Team | Lead | Focus |
| --- | --- | --- |
| Platform | Joost van Dijk | Kubernetes, databases, networking, on-call tooling |
| Probes | Ana Ribeiro | Probe workers, scheduling, check types |
| Core API | Tomasz Nowak | Public API, accounts, alert routing |
| Web | Chloé Martin | Dashboard, status pages, signup flows |
| Revenue engineering | Priya Raman | Billing, plans, usage metering |
| Support | Kwame Mensah | Tickets, customer escalations, help center |
| Sales | Daniel Okafor | New business and expansion |
| People Ops | Sanne Bakker | Hiring, onboarding, benefits |

## How we work

### Remote first

Almost everyone works from home. We keep a small office in Rotterdam for people who prefer a desk away from home and for
team days; see [Rotterdam office](office-rotterdam.md). Nobody is expected to come in.

### Overlap hours

We ask everyone to be reachable between 14:00 and 17:00 CET on working days. Our US colleagues start early so that
those three hours overlap with Europe. Outside the overlap, write things down and expect an answer the next day.

### Deep Work Thursday

We keep Thursdays free of internal meetings. Do not schedule stand-ups, one-on-ones, planning or demos on that day.
Customer calls, interviews and incidents are the only exceptions. Block the day in your calendar so the scheduling
assistant does not offer it to others.

### Writing over talking

Decisions are made in writing: a short proposal in the docs repository or a Linear issue, with a deadline for comments.
Meetings are for the things writing is bad at, such as brainstorming or a hard conversation. Every meeting has an
agenda in the invite; no agenda, no meeting.

## Values

1. **Customers sleep well.** Beacon exists so our customers find out about outages before their users do. Reliability
   work is never "extra".
2. **Small and sharp.** We are a small company on purpose. We prefer doing fewer things well.
3. **Say it early.** Bad news, slipped deadlines and mistakes are shared as soon as you know, not when they are fixed.
4. **Leave it better.** If a doc, test or runbook confused you, fix it before you move on.

## Who to ask

| Topic | Where |
| --- | --- |
| Payroll, contracts, leave | #people-ops or people@northwindlabs.io |
| Laptop, accounts, access | #it-help |
| Anything production | #beacon-platform |
| Customer questions | #support-escalations |
| Everything else | #general, or your manager |
