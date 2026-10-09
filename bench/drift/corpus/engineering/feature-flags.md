# Feature flags

Feature flags let us merge unfinished work, release it to a few customers first, and turn it off without a deploy. They
also add branches to the code that someone has to remove later. This page is about using them without making a mess.

## Where flags live

Flags are managed in **LaunchDarkly**, in the `beacon` project, with one environment each for development, staging and
production. Backend services read flags through the thin wrapper in `internal/flags`; the dashboard uses the React SDK.
Never call the vendor SDK directly from service code; the wrapper adds defaults, logging and the test helpers.

## Kinds of flags

| Kind | Example | Lifetime |
| --- | --- | --- |
| Release | `release_multistep_checks` | Removed after the feature is fully rolled out |
| Experiment | `exp_onboarding_checklist` | Removed when the experiment ends |
| Ops toggle | `ops_disable_sms_fallback` | Long-lived; documented in the runbook it belongs to |
| Entitlement | `plan_private_locations` | Long-lived; owned by Revenue engineering |

## Naming

- Prefix with the kind: `release_`, `exp_`, `ops_`, `plan_`.
- Use `snake_case` and describe the behaviour, not the ticket: `release_status_page_custom_css`, not `bea_812`.
- Every flag has a description and an owner team in its settings.

## Rolling out

1. Merge with the flag off everywhere.
2. Turn it on in staging and for the internal Northwind workspace.
3. Turn it on for a few friendly customers (a segment in the flag tool), then by percentage.
4. At 100% for a week without trouble, open the cleanup pull request.

Rolling back is turning the flag off. Make sure the "off" path still works after the "on" path has been live for a
while; for instance, data written by the new path must still be readable by the old one.

## Cleanup

A release flag that has been at 100% for 30 days is considered stale. The weekly stale-flag report in #eng-flags lists
them per team. Removing a flag means removing the code path and the flag itself in the same pull request.

## Testing with flags

Use `flags.ForTest(t, map[string]bool{...})` to set flags in unit tests. Tests should cover both states of a release
flag until it is removed.

## Who can change a flag in production

Anyone in Engineering can change flags in development and staging. In production, changes need the flag owner team, or
the on-call engineer during an incident. Every production change is posted to #eng-flags automatically.
