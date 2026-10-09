# Local development

How to get the `beacon` monorepo and the `beacon-web` dashboard running on your laptop. Expect the first setup to take
about an hour, most of it downloads.

## Prerequisites

- macOS with the developer tools: `xcode-select --install`
- [Homebrew](https://brew.sh)
- A container runtime. We use OrbStack; Docker Desktop also works but is slower on our machines.
- Access to the `northwind` GitHub organization and the shared 1Password vault "Engineering".

## Toolchain

We pin tool versions with `mise`, which reads the `.tool-versions` file at the root of each repository. After installing
mise, it picks the right versions automatically when you `cd` into a repository.

| Tool | Version | Used for |
| --- | --- | --- |
| Go | Go 1.22.5 | All backend services |
| Node.js | Node.js 20.11 (LTS) | `beacon-web` and the docs site |
| pnpm | 9.x | JavaScript packages |
| golangci-lint | 1.59 | Go linting, also run in CI |
| Terraform | 1.8 | Only if you work on `terraform/` |

Please do not install a different Go or Node version globally "just to try". Version drift between laptops and CI is the
most common cause of "works on my machine".

## First setup

Clone the monorepo and run the bootstrap target. It installs the toolchain through mise, fetches Go modules, installs
the git hooks and starts the local dependencies.

```bash
git clone git@github.com:northwind/beacon.git
cd beacon
make bootstrap
```

When it finishes, `make doctor` checks that everything is in place and prints what is missing.

## Local dependencies

`docker compose` runs the stores Beacon needs. The compose file lives in `dev/compose.yaml`.

| Service | Local port | Notes |
| --- | --- | --- |
| Postgres | 5432 | Database `beacon_dev`, user `beacon`, password `beacon` |
| ClickHouse | 8123 (HTTP), 9000 (native) | Empty on first start; `make seed` fills it |
| NATS | 4222 | JetStream enabled, streams created by `make seed` |
| Redis | 6379 | No persistence |
| Mailpit | 8025 | Catches every email the notifier sends |

## Running services

```bash
make run SERVICE=beacon-api     # http://localhost:8080
make run SERVICE=scheduler
make run SERVICE=probe-worker   # runs checks from your laptop as location "local"
make run SERVICE=ingester
```

The dashboard runs from the other repository:

```bash
cd ../beacon-web
pnpm install
pnpm dev                        # http://localhost:3000, talks to the local API
```

## Useful make targets

| Target | What it does |
| --- | --- |
| `make test` | Unit tests for the whole monorepo |
| `make test-integration` | Integration tests against the compose stack |
| `make lint` | golangci-lint and the custom analyzers |
| `make seed` | Loads fixtures: three accounts, 50 monitors, a week of results |
| `make reset` | Drops and recreates all local databases |

## Troubleshooting

- **Port already in use**: something else (often an old Postgres from Homebrew) is listening. `lsof -i :5432` shows
  what.
- **Go module download fails**: check that `GOPRIVATE=github.com/northwind/*` is set; bootstrap adds it to your shell
  profile.
- **ClickHouse eats your memory**: lower `max_server_memory_usage` in `dev/clickhouse/config.xml`.
