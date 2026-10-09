# Code review

Every change to the `beacon` and `beacon-web` repositories goes through a pull request. Review is how we share knowledge
and catch mistakes, not a gate to be rushed through. This page lists the rules and the habits we expect.

## Rules

1. No direct pushes to `main`. Branch protection enforces this for everyone, including admins.
2. Every pull request needs at least one approval from someone other than the author.
3. CI must be green. Do not merge with failing or skipped required checks, even "just this once".
4. Code owners must approve changes to the paths they own (see below).
5. Squash-merge only. The pull request title becomes the commit message, so make it meaningful.

## Code owners

The `CODEOWNERS` file at the root of each repository maps paths to GitHub teams. GitHub requests a review from them
automatically.

| Path | Team | Why |
| --- | --- | --- |
| `services/billing/` | `@northwind/billing-core` | Money and invoices; mistakes reach customers' bank accounts |
| `services/auth/` | `@northwind/core-api` | Sign-in, tokens, permissions |
| `services/probe-worker/` | `@northwind/probes` | Runs on hosts we do not fully control |
| `deploy/`, `terraform/` | `@northwind/platform` | Infrastructure |
| `db/migrations/` | `@northwind/platform` | Schema changes need a migration plan |

For billing and auth changes, the code owner approval is required **in addition to** the normal approval, so those pull
requests need two reviewers.

## Size

Keep pull requests small. The soft limit is **400 changed lines**, not counting generated code, fixtures and lock files.
Larger changes are fine when they are mechanical (a rename, a dependency bump); say so in the description. Otherwise,
split them: a refactor first, the behaviour change second.

## Writing the description

A good description answers three questions:

- **What** changes, in one or two sentences.
- **Why** now; link the Linear issue.
- **How to verify**: what you tested, and what the reviewer should look at first.

Screenshots or a short recording for anything visible in the dashboard.

## Reviewing

- Pick up review requests within one working day. If you cannot, say so and suggest someone else.
- Prefix comments so the author knows what matters: `blocking:`, `question:`, `nit:`.
- Review the tests as carefully as the code.
- Approve with nits when the nits are small. Trust the author to fix them before merging.
- Pull the branch and run it when the change is risky or hard to read in the diff.

## Commit messages

We use Conventional Commits for pull request titles, because the release notes are generated from them:

```text
feat(api): add cursor pagination to /v2/incidents
fix(probe-worker): close idle TCP connections after a DNS failure
chore(deps): bump golang.org/x/net
```

## Draft pull requests

Open a draft early when you want feedback on the approach. Reviewers do not need to look at drafts unless you ask them
to. Mark the pull request ready when it passes CI and you would be happy to merge it.
