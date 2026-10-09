# Testing

What we test, how, and what CI enforces. The short version: unit tests for logic, integration tests for anything that
talks to a store, a small end-to-end suite for the paths customers use most.

## The layers

| Layer | Tooling | Runs | Typical time |
| --- | --- | --- | --- |
| Unit | `go test`, Vitest | On every push | Under 3 minutes |
| Integration | `go test -tags integration` with Testcontainers | On every pull request | About 9 minutes |
| End-to-end | Playwright against staging | After every staging deploy, and nightly | About 20 minutes |
| Load | k6 | Before releases that touch the hot path | On demand |

### Unit tests

Unit tests live next to the code (`foo_test.go`). Use table-driven tests for anything with more than two cases. Do not
reach for mocks when a small fake will do; the `internal/fakes` package has fakes for the clock, the result stream and
the notifier.

### Integration tests

Integration tests start real Postgres, ClickHouse and NATS containers. They are slower, so keep them focused: one test
per behaviour that crosses a boundary (a migration, a query, a stream consumer).

```bash
make test-integration              # everything
go test -tags integration ./services/ingester/...   # one service
```

### End-to-end tests

The Playwright suite in `beacon-web/e2e` signs up a fresh account, creates monitors of each type, forces a failure and
checks that the alert arrives in Mailpit. If you change a flow that customers use every day, add or update a test here.

## Coverage

CI measures line coverage per Go package. A **new** package must reach at least **68%** before its first pull request
can be merged; existing packages must not drop by more than two percentage points in a single pull request.

Coverage is a smoke alarm, not a goal. A test that only executes code without asserting anything is worse than no test,
because it hides the gap.

## Flaky tests

A flaky test is one that fails and then passes on retry without any code change.

1. Open a Linear issue with the label `flaky` and the failing CI link.
2. Skip the test with a reference to the issue: `t.Skip("flaky, see BEA-1234")`.
3. The owning team has **10 working days** to fix or delete the test. After that, the issue is escalated to the team
   lead in the weekly engineering sync.

Never "fix" a flaky test by adding a sleep. Find the race.

## Test data

- Fixtures live in `testdata/` folders and are small and readable.
- Never copy production data into tests or fixtures, not even anonymized.
- Time-dependent tests use the fake clock; tests that call `time.Now()` directly are rejected in review.
