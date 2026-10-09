# Continuous integration

Every push to a pull request in `beacon` and `beacon-web` runs our CI pipeline on **Buildkite**. This page explains what
the pipeline does, how to read it, and what to do when it is red.

## Pipeline

The pipeline is defined in `.buildkite/pipeline.yml`. Steps run in parallel where they can.

| Step | What it checks | Required |
| --- | --- | --- |
| `lint` | golangci-lint, the custom analyzers, ESLint for the web app | Yes |
| `unit` | Unit tests with coverage per package | Yes |
| `integration` | Integration tests against containers | Yes |
| `openapi` | The OpenAPI file matches the handlers | Yes |
| `build` | Builds every service image and pushes it to ECR with the commit SHA as tag | Yes |
| `e2e-smoke` | A five-minute subset of the Playwright suite against a preview environment | No |

A pull request can be merged only when every required step is green. See [Testing](testing.md) for what the tests
cover and how the coverage gate works.

## Agents

CI jobs run on our own agents: an auto-scaling group of EC2 spot instances in eu-central-1, with a small on-demand pool
for the `build` step so image builds are not interrupted. Agents are recycled every night.

- Go module and build caches are kept on the agent's local disk and on a shared S3 cache.
- Docker layer caching uses the registry; the first build of a new base image is slow.

## When CI is red

1. Open the failing step and read the first error, not the last.
2. If it looks unrelated to your change, check #eng-ci; someone may already be on it.
3. Retry once. If it passes on retry, it is a flaky test: follow the flaky test steps in [Testing](testing.md).
4. If CI itself is broken (agents missing, cache errors), ping the Platform team in #beacon-platform.

## Secrets in CI

CI reads secrets from AWS Secrets Manager through the agent's instance role. Never put secrets in pipeline files or
environment variables in the CI settings. Pull requests from forks do not get secrets at all.

## Making CI faster

- Tests that need a store should share one container per package, not start one per test.
- Use `-run` patterns locally instead of pushing to "see what CI says".
- If a step regularly takes more than 15 minutes, open an issue for the Platform team; we track pipeline times on a
  dashboard.

## Changing the pipeline

Changes to `.buildkite/` need a review from the Platform team. Test pipeline changes on a branch first; the pipeline
file of the branch is used for that branch's builds.
