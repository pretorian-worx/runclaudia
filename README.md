# claudia

Diff-aware test plan agent. Reads a git diff, infers which user-facing flows were affected, and posts a structured test plan to the PR.

The CLI tells you what *should* be tested; you decide whether to run it. Useful as a reviewer's prompt or as a focused alternative to running a full E2E suite on every PR.

## Why

Most teams ship code and skip the manual post-deploy check. Full E2E suites are too slow to gate every deploy, so coverage drops to "did the build succeed." claudia closes that gap by giving every PR a focused, diff-scoped test plan in under a minute.

## Install

```bash
pnpm add -D @claudia/cli
```

Requires `ANTHROPIC_API_KEY` in the environment.

## Usage

```bash
# Run locally against a diff
claudia plan --base main --head HEAD

# Output JSON for tooling
claudia plan --base main --head HEAD --json

# Rebuild the route map cache
claudia map --refresh
```

## GitHub Action

```yaml
name: claudia
on:
  pull_request:
    # Don't even spin up a runner for diffs that can't affect runtime behavior.
    # claudia also classifies these internally and skips the LLM call, but
    # paths-ignore saves the workflow startup time as well.
    paths-ignore:
      - '**/*.md'
      - '**/*.mdx'
      - 'docs/**'
      - 'LICENSE*'
      - 'CHANGELOG*'
      - 'pnpm-lock.yaml'
      - 'package-lock.json'
      - 'yarn.lock'
      - 'bun.lockb'

permissions:
  contents: read
  pull-requests: write

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history; claudia needs base..head
      - uses: pretorian-worx/runclaudia@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action posts the plan as a sticky PR comment that updates in place on subsequent commits to the same PR.

## Status

v0.1 — early. Next.js App Router only. Expect rough edges.

## Releases

Versioning and tagging are automated via [release-please](https://github.com/googleapis/release-please) on push to `main`.

- Use **conventional commits** — `feat:`, `fix:`, `docs:`, `refactor:`, etc. Breaking changes: `feat!:` or a `BREAKING CHANGE:` footer.
- release-please opens a "Release PR" that bumps versions in every `package.json` and updates `CHANGELOG.md`.
- Merging the Release PR creates a `v0.x.y` git tag, a GitHub Release, and force-moves the `v0` major tag so `uses: pretorian-worx/runclaudia@v0` always points at the latest 0.x.

If the action's bundle (`packages/github-action/dist/`) is stale, CI will fail. Run `pnpm --filter @claudia/github-action build` and commit the result before pushing.
