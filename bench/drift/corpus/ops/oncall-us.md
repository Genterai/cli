# On-call: US rotation

The US rotation covers Beacon production from **19:00 to 07:00 CET** (13:00 to 01:00 Eastern), seven days a week, when
the [EU rotation](oncall-eu.md) is off. Because more than half of our customers are in the Americas, this is where many
of the real pages happen.

## Who is on it

Four engineers based in the US and Canada, plus volunteers from Europe who prefer evening shifts. One-week shifts with a
primary and a secondary. The PagerDuty schedules are **Beacon US Primary** and **Beacon US Secondary**.

## Handover

Shifts change on Mondays at 11:00 Eastern in a short call. Before the call, read the EU handover thread from the same
morning; the EU primary writes their summary there.

Things to cover:

- incidents still open and their next steps,
- noisy alerts and whether a silence is in place,
- planned work during US hours, such as provider maintenance windows.

## Communication

Shift chatter goes in **#beacon-oncall-us**. At 07:00 CET, the US primary writes a short note for the EU primary: what
happened overnight and what is still open.

## Escalation policy

- A page goes to the US primary first.
- If the primary does not acknowledge within **12 minutes**, PagerDuty escalates to the US secondary.
- If neither acknowledges after a further 12, PagerDuty calls the Head of Platform.

The window is longer than in Europe because US shifts include late evenings, when it can take a moment to get to a
laptop.

## Out-of-hours escalation

Between 19:00 and 07:00 CET, anyone at Northwind who notices production is broken (support, sales, an engineer up late
in Europe) should not try to find a person in Slack. Trigger an incident on the PagerDuty service
`beacon-after-hours`. It pages the US primary and opens an incident channel automatically. From the Slack command line:

```text
/pd trigger service:beacon-after-hours "Dashboard returns 502 for all EU customers"
```

## Compensation

US on-call pays **$450** per week as primary and $150 as secondary, paid through payroll. A page between midnight and
06:00 local time earns you a late start the next day.

## Expectations

- Acknowledge within the escalation window, and be at a laptop shortly after.
- If you are going to be out of reach for more than half an hour (a flight, a commute), hand over to the secondary in
  #beacon-oncall-us first.
- Follow the same severity rules and incident process as the EU rotation.

## Swaps and holidays

Swap shifts directly and update PagerDuty, then post it in #beacon-oncall-us. US public holidays are covered by
volunteers first; volunteers get an extra day off.
