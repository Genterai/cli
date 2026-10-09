# Support priorities and escalation

How Support prioritizes tickets, how fast we answer, and when and how we bring in engineering. Tickets live in Help
Scout; engineering work lives in Linear.

## Ticket priorities

| Priority | Meaning | Examples |
| --- | --- | --- |
| Urgent | Beacon is not doing its job for this customer right now | No alerts sent; all monitors show Unknown |
| High | A key feature is broken, with a workaround | Status page not updating; SMS alerts failing |
| Normal | Questions and small bugs | How do I set up a heartbeat? Chart looks wrong |
| Low | Feedback and feature requests | "Please add a dark mode to status pages" |

Support sets the priority, not the customer. If a customer marks something urgent that is not, change it and explain
why in the reply.

## First response targets

| Plan | Urgent | High | Normal |
| --- | --- | --- | --- |
| Enterprise | 45 minutes, around the clock | 4 hours | 1 business day |
| Business | 2 hours, business hours | 8 hours | 1 business day |
| Team and Starter | 1 business day | 1 business day | 2 business days |
| Free | Help center and community only | | |

Business hours are 08:00 to 20:00 CET on working days. The Enterprise urgent target is covered at night by the on-call
support engineer, who carries the support pager.

## When to involve engineering

- **Something is broken for many customers**: that is an incident. Tell the on-call engineer through PagerDuty (see the
  on-call pages in `ops/`) and post in #incidents. Do not wait for more tickets.
- **A bug for one customer**: open a Linear issue in the owning team's triage queue with the label `from-support`, the
  ticket link, the workspace ID and the steps to reproduce.
- **A question you cannot answer**: ask in #support-escalations. Engineers answer within the day.

## Explaining alerts to customers

Many tickets are about alerts the customer thinks are wrong. Before escalating, check the check history: which locations
failed, with what error, and at what time. Most "false" alerts turn out to be real but short outages, DNS changes or an
expired certificate on a redirect target.

If the failure came from one location only and the customer was still alerted, that is a bug; escalate it.

## Refunds and credits

Support can give service credits of up to one month for documented outages on our side. Anything larger, and every
refund, goes to the account owner in Sales.

## Writing replies

- Answer the question in the first sentence.
- Link to the help center instead of pasting long instructions.
- Never promise a date for a fix or a feature; say what we know and when we will update them.
- Close with a clear next step: who does what.

## Handovers

Support covers Europe and the US East Coast with two shifts. At the end of a shift, the outgoing engineer leaves a note
in #support-handover with open urgent and high tickets.
