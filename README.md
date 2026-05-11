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
  # `checks: write` is only required when using `mode: advisory` or
  # `mode: gating`; the default `shadow` mode only writes the PR comment.
  checks: write

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
          # mode: shadow | advisory | gating (default: shadow)
          # mode: advisory
          # blocking-risk: low | medium | high (gating only, default: high)
```

The action posts the plan as a sticky PR comment that updates in place on subsequent commits to the same PR.

## Trust gradient

| Mode | PR comment | PR check | When to use |
|---|---|---|---|
| `shadow` *(default)* | ✅ | — | Initial install; build confidence before any signal feeds back into the merge flow. |
| `advisory` | ✅ | neutral (always passes) | Teams that want the plan visible in the PR's status-checks UI but not blocking. |
| `gating` | ✅ | success/failure | Plans containing flows at or above `blocking-risk` fail the check. Combine with a branch protection rule on `claudia / plan` to actually block merges. |

The check name is always `claudia / plan` — stable so consumers can reference it in branch protection rules.

## Post-deploy verification — `claudia select`

For teams running a full E2E suite pre-merge, the bigger win comes from running a *targeted subset* against the **deployed production artifact** after promotion. Pre-deploy CI verifies code is correct in isolation; post-deploy verification catches env var drift, real auth-provider config, CDN cache state, and IaC misconfiguration — failures that pre-deploy CI can't see.

`claudia select` reads the diff between the last-deployed SHA and the just-deployed SHA, intersects it with the indexed spec coverage, and outputs the targeted spec subset:

```bash
# Default: human-readable markdown summary
claudia select --base $LAST_DEPLOY_SHA --head $JUST_DEPLOYED_SHA

# Machine-readable JSON for CI pipelines
claudia select --base $LAST_DEPLOY_SHA --head $JUST_DEPLOYED_SHA --json

# Just the Playwright --grep pattern (empty if nothing eligible)
claudia select --base $LAST_DEPLOY_SHA --head $JUST_DEPLOYED_SHA --grep-only

# Just selected spec file paths, one per line
claudia select --base $LAST_DEPLOY_SHA --head $JUST_DEPLOYED_SHA --files-only
```

### Example: post-deploy verification workflow

This is a separate workflow file from the PR-time `claudia.yml`. It runs after a deploy promotes to production and feeds claudia's selection into your existing Playwright invocation:

```yaml
name: claudia post-deploy verify
on:
  workflow_run:
    workflows: ["Deploy to prod"]   # whatever your deploy workflow is named
    types: [completed]

jobs:
  verify:
    if: github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.workflow_run.head_sha }}

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Resolve last-deployed SHA
        id: last
        run: |
          # Read your "last successful prod deploy" SHA — adapt to your setup.
          # Common patterns: a `prod` tag, the previous deploy's commit from
          # GitHub Deployments API, a manually-maintained file, etc.
          echo "sha=$(gh api repos/${{ github.repository }}/deployments \
            --jq '[.[] | select(.environment=="production")] | .[1].sha')" >> $GITHUB_OUTPUT

      - name: Select specs covering the diff
        id: select
        run: |
          GREP=$(npx -y @claudia/cli select \
            --base ${{ steps.last.outputs.sha }} \
            --head ${{ github.event.workflow_run.head_sha }} \
            --grep-only)
          echo "grep=$GREP" >> $GITHUB_OUTPUT

      - name: Run the selected specs against production
        if: steps.select.outputs.grep != ''
        env:
          PLAYWRIGHT_BASE_URL: ${{ vars.PROD_URL }}
          TEST_USER_TOKEN: ${{ secrets.PROD_TEST_USER_TOKEN }}
        run: npx playwright test --grep "${{ steps.select.outputs.grep }}"
```

Claudia handles the **selection** (which specs to run, given the diff). Your existing Playwright config handles **execution** (auth, base URL, reporting). Auth and runtime are intentionally outside v0.9 — they're well-served by what you've already wired up for pre-deploy CI.

A future release will bundle execution + auth recipes + a Slack reporter, but the selection primitive works standalone today.

## Status

v0.9 — Mission A map foundation complete (routes, endpoints, infra, DB schema, spec coverage). PR-time plan-only advisor stable; post-deploy verification primitive (`claudia select`) just landed. Next.js App Router + Terraform + Prisma + Playwright/Cypress. Other frameworks/ORMs are incremental.

## Releases

Versioning and tagging are automated via [release-please](https://github.com/googleapis/release-please) on push to `main`.

- Use **conventional commits** — `feat:`, `fix:`, `docs:`, `refactor:`, etc. Breaking changes: `feat!:` or a `BREAKING CHANGE:` footer.
- release-please opens a "Release PR" that bumps versions in every `package.json` and updates `CHANGELOG.md`.
- Merging the Release PR creates a `v0.x.y` git tag, a GitHub Release, and force-moves the `v0` major tag so `uses: pretorian-worx/runclaudia@v0` always points at the latest 0.x.

If the action's bundle (`packages/github-action/dist/`) is stale, CI will fail. Run `pnpm --filter @claudia/github-action build` and commit the result before pushing.
