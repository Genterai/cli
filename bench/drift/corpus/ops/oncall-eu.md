# On-call: EU rotation

Beacon runs follow-the-sun on-call with two rotations. The EU rotation covers production from **07:00 to 19:00 CET**,
seven days a week. The rest of the day belongs to the [US rotation](oncall-us.md).

## Who is on it

Six engineers from Platform, Probes and Core API. Each shift is one week, with a primary and a secondary. You are
primary roughly one week in six and secondary once in between. New engineers join after three months and two
shadow shifts (see [Onboarding](../handbook/onboarding.md)).

The schedule is in PagerDuty as **Beacon EU Primary** and **Beacon EU Secondary**.

## Handover

Shifts change on **Mondays at 10:00 CET** with a 15-minute call between the outgoing and incoming primary. Go through:

- open incidents and follow-ups,
- alerts that fired more than twice in the week and why,
- anything scheduled for the coming week (migrations, provider maintenance, big customer launches).

Write the summary in the handover thread so the US rotation can read it too.

## Communication

Everything about the current shift goes in **#beacon-oncall-eu**: acknowledgements, "looking into it", hand-offs to the
secondary, and the end-of-day note for the US primary. Customer-facing updates are written by the incident commander in
#incidents, not here.

## Escalation

1. A page goes to the primary.
2. If the primary has not acknowledged after 8 minutes, PagerDuty pages the secondary.
3. If neither acknowledges after another 8 minutes, PagerDuty pages the Platform team lead.
4. For a SEV1, the primary pulls in the secondary right away; do not wait for an escalation.

## Expectations

- Acknowledge a page within 5 minutes during your hours, and be at a laptop within 15.
- Carry your laptop and a charged phone. Stay within reach of a decent internet connection.
- You are not expected to fix everything yourself. Stabilize, communicate, and get help.
- Ignore non-paging alerts outside working hours; they wait for the next morning.

## Compensation

EU on-call pays **€400 per week** as primary and €150 as secondary, paid with the next salary. If you are paged between
22:00 and 07:00 local time (it happens when the US rotation escalates), you get the next morning off.

## Swapping shifts

Swap directly with a colleague and update PagerDuty yourself, then post the swap in #beacon-oncall-eu. Swaps that leave
a gap in the schedule are not allowed; PagerDuty shows uncovered hours in red.

## Before your first shift

- Make sure PagerDuty can call and text you (send a test notification).
- Check you can reach the production clusters with read-only access.
- Read the runbooks in `ops/runbooks/` and the [Incident response](incident-response.md) page.
