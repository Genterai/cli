# Contributing to Genter

Thanks for helping. This repository is Genter's engine: the `genter` command, its MCP server and its library.
Issues and pull requests are welcome.

## Before you start

- **A bug or an idea:** open an issue here. For a bug, say what you ran, what you expected and what happened, with
  `genter --version`, `node --version` and your OS.
- **Behaviour comes from specs.** Everything a person, an API or an MCP client can observe is written down first in
  [Genterai/specs](https://github.com/Genterai/specs). Every spec lists the code it describes in its `code:` header,
  so `grep -rl "genter-cli:src/local.js" specs --include=*.md` finds the specs of a file.
- **A new behaviour** that no statement covers starts as a pull request (or an issue) in Genterai/specs, then the code.

## Set up

```bash
git clone https://github.com/Genterai/genter && cd genter
npm ci
npm test              # Node's own test runner: no key, no network
npm run lint          # Biome
npm run bench         # DriftBench, offline, about a second
node bin/genter.js demo
```

Node 20 or later. `npm ci` also installs `@composio/core` and `zod`, which only the app commands need.

## What the code keeps to

- **No runtime dependencies.** The local commands run on Node alone, and `@composio/core` and `zod` stay optional peers
  of the app commands. A pull request that adds a package to `dependencies` is not merged.
- **Nothing copied.** Local search never stores the text of a file or a page: its store keeps places, digests,
  headings and dates, sealed.
- **Nothing run.** Genter never runs what it reads: no `child_process`, `vm`, `eval`, `new Function` or
  `worker_threads` in `src/`.
- **Comments say why**, in the style of the file around them.

## Tests

- A change comes with tests in `test/*.test.js`.
- A test that checks a spec statement carries its full id in its name: `[spec:local-search/reads-again]`.
- CI runs lint and the tests on Node 20 and 22 for every pull request.

## Pull requests

- One change per pull request, said in "What and why".
- The description ends with one line that the `spec-check` workflow reads:

  ```
  Specs: implements <spec-id/statement-id>, ...
  Specs: updated <link to the Genterai/specs pull request>
  Specs: none - <why no behaviour changes>
  ```

- **Releases:** raise `version` in `package.json` (semver) in the pull request. Merging it into `main` publishes it to
  npm and makes the GitHub release; a pull request that keeps the version releases nothing.

## Conduct and licence

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree that your contributions are
licensed under the [Apache License 2.0](LICENSE), the licence of this repository.
