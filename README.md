# MCP Drift Check

Report dependency changes observed in your selected time window. Version 3 runs in advisory mode by default.

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
      - uses: Nikolife2016/mcp-drift-action@v3
        with:
          packages: "mcp-remote,@upstash/context7-mcp"
          fail-on: never  # report changes without blocking the build
```

**Upgrading from v2.** Explicit `packages` lists continue to work. If you use discovery, set both inputs below when upgrading to v3. In v2.0.0, `share-discovered: true` can send every discovered name, including private dependencies.

```yaml
- uses: Nikolife2016/mcp-drift-action@v3
  with:
    share-discovered: true
    approved-discovered-packages: "mcp-remote,@upstash/context7-mcp"
```

Discovery sends the intersection of this list and the names found in supported manifests or MCP configs. Matching is exact and case-sensitive. The explicit `packages` input takes priority and works independently of the contents of the repository. A discovery request without a valid approval list stops with a configuration error before sending a request. An approved list with no matches produces `not_checked` and zero requests. For a blocking severity threshold, set `fail-on: high` or `medium` explicitly.

**Run it on a schedule, not only on pull requests.** Drift happens between your commits, not during them — that is the entire point.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `packages` | empty | Comma-separated names approved for submission |
| `share-discovered` | `false` | Enable local discovery using the exact list below |
| `approved-discovered-packages` | empty | Comma-separated names approved for discovery mode. Use literal npm names, including the full scope for a scoped package. |
| `days` | `30` | How far back to look |
| `fail-on` | `never` | `high`, `medium`, or `never` (report only) |
| `api` | `https://pulsefeed.dev` | HTTPS base URL, optionally with a path prefix. Local tests can use HTTP on loopback. Redirects are refused. |
| `allowlist` | `.mcp-drift-allowlist.json` | File of reviewed events, see below |

### What leaves the runner

The Action calls `GET <api>/mcp/drift.json` with two query fields, `days` and `packages`. The destination receives the approved names that were selected and can log the request URL. Approval is the caller’s choice: a scoped or unscoped name may be private. Keep confidential names out of the approval inputs unless you intend to share them with that destination. Dependency versions, manifest values, workspace paths, MCP arguments and review notes stay local.

The Action emits counters and status fields. For findings, its own logs and job summary use selected names and bounded event metadata. GitHub can separately display workflow inputs and runner diagnostics. GitHub and the API operator control retention in their respective systems.

## Outputs

| Output | Meaning |
|---|---|
| `check_status` | `notable` if a medium/high event was returned, including an acknowledged one. Otherwise `no_notable_events` for complete coverage, `partial`, `unknown_coverage`, `unavailable` or `not_checked`. |
| `coverage_status` | `complete` when each candidate name has evidence, each scoped response confirms the requested names and total, all sources were read and every event was returned. `partial` for mixed, truncated or explicitly incomplete results. `unknown` when the feed responded without evidence for any submitted package. `unavailable` when every batch failed. `not_checked` when no request was made. |
| `coverage_complete`, `covered`, `unknown` | Boolean for complete coverage, count of names with an observed event or evidence of a repeat audit in the window, and count of candidates without evidence (including excluded invalid names). A single observation does not establish continuous monitoring. |
| `source_error`, `truncated`, `invalid_inputs` | Whether a batch failed transport or response validation, whether a valid response omitted events, and count of unique invalid package names. A readable response that explicitly reports incomplete source data also yields partial coverage. |
| `routine`, `notable` | Counts of returned low-severity and medium/high-severity events respectively. Truncation or an outage can hide additional events. |
| `events`, `high`, `acknowledged` | Open notable events, open high-severity events, and acknowledged notable events. `notable = events + acknowledged`. |
| `baseline_status` | `unknown`. This version has no input for the baseline a client approved when adopting a package. A dated audit or allowlisted event cannot establish that baseline. |
| `fail_on` | Applied threshold for open events. `never` is advisory, `high` and `medium` enforce the explicit threshold. An invalid value yields `invalid`, exits with an error and makes zero feed requests. |

The action writes findings, coverage and policy to the GitHub job summary when available. If the runner sets `GITHUB_OUTPUT` and the write fails, the action exits with an infrastructure error even in advisory mode. Zero open events can accompany a 503, an unknown package or a fully observed quiet window. Check both status outputs. If one batch fails, valid findings from other batches still count. Older servers can provide event evidence while leaving coverage for quiet packages unknown.

## When it fires for real: acknowledging a reviewed change

A real event stays in the window for `days` days. Without a way to say "we looked at this", the build stays red for a month and the check gets removed — which is worse than no check. So there is a file for reviewed events, `.mcp-drift-allowlist.json` in the repository root (path configurable with `allowlist`):

```json
{
  "reviewed": [
    {
      "eventId": "eb9c6cb717f2e882",
      "package": "@modelcontextprotocol/sdk",
      "type": "maintainer_changed",
      "reviewedBy": "nikolife",
      "reviewedAt": "2026-09-19",
      "reason": "one maintainer left the team; confirmed with the remaining maintainers, no release since 1.30.0"
    }
  ]
}
```

Use the event identifier in the failure output to record a review in this file.

Three rules make this safe rather than a mute button:

- **You acknowledge the event, not the package.** `eventId` is a content hash of one specific change (its recipe is published in the feed as `idRecipe`). A new event on the same package fails the build again.
- **Every entry names who, when and why.** `reviewedBy`, `reviewedAt` and `reason` are required; an entry without them is ignored with a warning. `package` and `type` are optional, but if present they must match the event — pasting the wrong id does nothing.
- **A broken file means no acknowledgements.** Invalid JSON is reported and treated as empty, so an error leads to a red build, never to a green one.

Acknowledged events appear in the job summary with their review status. The reviewer and reason remain in the local review file. Only open events contribute to the failure decision and the `events`/`high` outputs.

## When it does not fail your build

Downstream workflows are advisory by default. Missing coverage or API errors alone do not fail a downstream run. With an explicit event threshold, any confirmed open event at that severity or higher fails the run, including when another batch is unavailable. The repository’s own scheduled self-check also fails on missing inputs, invalid responses, explicit source-read failures and transport errors. It emits the counters before returning its exit code.

Routine version bumps are counted but not printed. They are context for the other events, not news.

## Why it re-checks on every run, not only the packages that looked risky

The tempting design is to re-audit only the dependencies most likely to have changed and skip the rest. It saves work and it misses the point. An independent measurement of the MCP registry ([Bharti & Agnihotri, *Declared vs. Observed*](https://doi.org/10.5281/zenodo.22649163)) found that between 43% and 51% of the servers that changed had no prior change to rank on — they were new — so no history-based ranking reaches them at any budget. The same corpus put the rate a re-check has to outrun at **18.3% of tools over 21 days**.

Explicit mode queries the selected package names on each run. Discovery mode reads supported manifests and MCP configs locally and queries matching approved names. It does not enumerate transitive dependencies from lockfiles. Ranking decides the order work is done inside a run, never what gets checked at all. A dependency that has been quiet is exactly the one a drift-ranked scanner stops looking at, and quiet is not the same as unchanged.

## Where the data comes from

[PulseFeed](https://pulsefeed.dev) re-reads npm metadata for the MCP package population every night — install scripts, ownership, provenance, repository, licence, liveness — and diffs each package against the previous day's snapshot. An event exists only because a snapshot from before it exists.

That is also why it cannot be reconstructed later: whoever starts tomorrow has no yesterday. The series runs from 2026-07-30.

Public feed: [pulsefeed.dev/mcp/drift](https://pulsefeed.dev/mcp/drift) · JSON: `/mcp/drift.json?packages=a,b` · RSS per watchlist: `/mcp/drift.rss?packages=a,b`

## Licence

MIT
