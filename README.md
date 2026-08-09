# MCP Drift Check

Fail your build when a dependency changed **dangerously after you adopted it**.

Every scanner answers one question: *is this package safe today?* A rug pull is the other question. The package was clean when it was reviewed, collected installs for weeks, and only then shipped a patch that runs code on `npm i`. Static scanning cannot catch that by definition — at review time the code was clean.

This action asks an external observer that re-audits the whole MCP package population every night and records the transitions:

- an **install script added** in a later version — arbitrary code on `npm i` that was not there at review time
- **package ownership swapped** — whoever you trusted is no longer the one publishing
- **repository removed** — the source can no longer be reviewed
- **package unpublished** — installs break and the name is free for anyone to claim
- **build provenance lost** — the link between the package and its repository is no longer proven

## Usage

```yaml
name: Dependency drift
on:
  schedule: [{ cron: "0 6 * * *" }]   # the point is the daily run, not the PR
  pull_request:

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Nikolife2016/mcp-drift-action@v1
```

That is the whole setup. No API key, no signup, no dependencies. Package names are read from your `package.json` (including `packages/*` and `apps/*` in a monorepo) and from any MCP config in the repo — `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `claude_desktop_config.json`, `.claude/settings.json`.

**Run it on a schedule, not only on pull requests.** Drift happens between your commits, not during them — that is the entire point.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `packages` | auto-detect | Comma-separated names, if you would rather be explicit |
| `days` | `30` | How far back to look |
| `fail-on` | `high` | `high`, `medium`, or `never` (report only) |
| `api` | `https://pulsefeed.dev` | Override only for self-hosting |

## Outputs

`events` — notable changes found. `high` — how many were high severity.

## When it does not fail your build

If the API is unreachable, the step says so and **passes**. A check that goes red for reasons outside your repository gets deleted after the second false alarm, and then you have no check at all.

Routine version bumps are counted but not printed. They are context for the other events, not news.

## Where the data comes from

[PulseFeed](https://pulsefeed.dev) re-reads npm metadata for the MCP package population every night — install scripts, ownership, provenance, repository, licence, liveness — and diffs each package against the previous day's snapshot. An event exists only because a snapshot from before it exists.

That is also why it cannot be reconstructed later: whoever starts tomorrow has no yesterday. The series runs from 2026-07-30.

Public feed: [pulsefeed.dev/mcp/drift](https://pulsefeed.dev/mcp/drift) · JSON: `/mcp/drift.json?packages=a,b` · RSS per watchlist: `/mcp/drift.rss?packages=a,b`

## Licence

MIT
