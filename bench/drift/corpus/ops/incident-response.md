# Incident response

An incident is anything that hurts customers now or will soon: checks not running, alerts not sent, the dashboard down,
data in the wrong place. When in doubt, declare one. Closing an incident that turned out to be nothing costs a minute;
missing a real one costs customers.

## Severity levels

| Level | Meaning | Examples |
| --- | --- | --- |
| SEV1 | Beacon's core promise is broken for many customers | Checks not running in a region; alerts not delivered |
| SEV2 | A major feature is broken or badly degraded | Status pages down; results delayed by more than 10 minutes |
| SEV3 | A minor feature is broken, or a risk with no customer impact yet | One probe location down; backup failing |

## Declaring an incident

1. In Slack, run `/incident declare` and pick a severity. The bot creates a channel named `#inc-<date>-<short-name>`
   and posts in #incidents.
2. The person who declares is the incident commander (IC) until they hand it over.
3. For SEV1 and SEV2, the IC pages the on-call secondary and, if needed, the owning team.

## Roles

- **Incident commander**: runs the incident, decides, delegates. The IC does not debug.
- **Communications lead**: writes status page updates and talks to Support.
- **Scribe**: keeps the timeline in the incident channel.
- **Responders**: everyone fixing things.

For a small incident one person can hold several roles. For a SEV1 the three roles are always different people.

## The call

For SEV1 and SEV2 incidents, responders meet on the standing Zoom room **beacon-war-room**, which is always open. The
link is pinned in #incidents. Keep the call for coordination; detailed debugging can move to breakout rooms.

## Talking to customers

- The status page is updated within 15 minutes of declaring a SEV1 or SEV2, and then at least every 30 minutes.
- Write what customers see and what they should do, not what is broken inside.
- Support gets the same text for tickets; the communications lead posts it in #support-escalations.

## Closing

The IC closes the incident when customer impact has ended and the risk of it coming back is low. Follow-up work goes in
Linear with the label `incident-followup`.

## Post-incident review

Every SEV1 and SEV2 gets a written review (we call it a PIR). It is blameless: we look at how the system and the process
let the problem happen, not at who pressed what.

- The IC owns the PIR and assigns a writer.
- The PIR is published in the docs repository within **5 business days** of the incident closing.
- It contains a timeline, the impact in numbers, what went well, what did not, and follow-ups with owners.
- PIRs are discussed in the monthly reliability review.

SEV3 incidents get a short summary in the incident channel instead.

## Practice

Platform runs a game day every quarter: we break something on staging on purpose and run the incident process for real,
including the status page (on a test page) and the PIR.
