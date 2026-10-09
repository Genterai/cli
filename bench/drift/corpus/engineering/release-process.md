# Release process

How code gets from `main` to customers. Deploying itself is described in [Production deploys](../ops/deploy-production.md)
and [Staging](../ops/deploy-staging.md); this page is about the rhythm, the versioning and the paperwork.

## Versioning

Backend releases use calendar versioning in the form `YYYY.MM.N`, where `N` counts releases within the month and starts
at 1. Example: the third release in August 2026 is `2026.08.3`. Hotfixes add a patch suffix: `2026.08.3-hf1`.

The dashboard (`beacon-web`) deploys continuously and does not carry a version number. The public API is versioned
separately by its URL path; see [API guidelines](api-guidelines.md).

## The release train

We release the backend once a week on a fixed schedule, so nobody has to ask "when will this be out?".

1. The release branch is cut from `main` every week on **Wednesdays at 11:00 CET** by the release bot. Whatever is merged
   by then is on the train.
2. The branch deploys to staging automatically and soaks there for 24 hours. QA runs the regression suite during the
   afternoon.
3. The release captain promotes the branch to production the next day, following the production deploy steps.
4. The release bot posts the release notes in #releases and on the public changelog.

If the train is cancelled (holidays, a freeze, an open SEV1), the release captain announces it in #releases and the next
train takes everything.

## Release captain

The captain rotates weekly among backend engineers; the schedule is pinned in #releases. The captain:

- watches the staging soak and decides whether to promote,
- follows up on regressions found by QA,
- writes the customer-facing summary for the changelog,
- hands over open problems to the next captain.

## Hotfixes

A hotfix skips the train. Use it only for customer-visible bugs that cannot wait for the next train, or security fixes.

```bash
git checkout -b hotfix/2026.08.3-hf1 release/2026.08.3
git cherry-pick <sha-from-main>
git push -u origin hotfix/2026.08.3-hf1
```

The fix must land on `main` first (or at the same time), so the next train does not undo it. Hotfixes still need the
normal review and green CI.

## Changelog

The public changelog is generated from pull request titles (see [Code review](code-review.md)). Anything with `feat` or
`fix` appears; `chore` and `refactor` do not. The captain can edit the generated text before it is published, and should
for anything that needs context.

## Feature flags and releases

Big features ship dark behind a flag and are enabled separately from the release (see [Feature flags](feature-flags.md)).
That way the release train never waits for a feature to be "ready".
