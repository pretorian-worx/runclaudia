# claudia

Diff-aware test plan agent. Reads a git diff, infers which user-facing flows were affected, and posts a structured test plan to the PR.

The CLI tells you what *should* be tested; you decide whether to run it. Useful as a reviewer's prompt or as a focused alternative to running a full E2E suite on every PR.

## Why

Most teams ship code and skip the manual post-deploy check. Full E2E suites are too slow to gate every deploy, so coverage drops to "did the build succeed." claudia closes that gap by giving every PR a focused, diff-scoped test plan in under a minute.

## Install

Run via `npx` — no install, no auth setup:

```bash
npx -y @pretorian-worx/runclaudia-cli <subcommand> [args]
```

`claudia plan` requires `ANTHROPIC_API_KEY` in the environment. All other subcommands (`map`, `select`, `run`, `ratings`) are deterministic local code — zero API calls.

For global install:

```bash
npm i -g @pretorian-worx/runclaudia-cli
claudia <subcommand> [args]
```

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

Claudia handles the **selection** (which specs to run, given the diff). Your existing Playwright config handles **execution** (auth, base URL, reporting).

### Or: let claudia run them too — `claudia run`

`claudia run` bundles selection + execution into a single command. It calls `claudia select` internally, then spawns `npx playwright test` with the selected files/grep, `PLAYWRIGHT_BASE_URL` set to your target, and Playwright's JSON reporter wired up for a structured summary:

```bash
claudia run \
  --base $LAST_DEPLOY_SHA \
  --head $JUST_DEPLOYED_SHA \
  --target https://app.example.com \
  [--playwright-config playwright.prod.config.ts] \
  [--json] [--dry-run]
```

Output (markdown):

```
## claudia — post-deploy verification
Target: `https://app.example.com`

**✅ Pass** — 4/4 passed.  ⏱ 12.3s
```

…or on failure:

```
**❌ Fail** — 3/4 passed, 0 flaky.  ⏱ 14.1s

### Failures

**e2e/bugs.spec.ts** — `lists bugs`
```

`npx playwright test` runs in the project's normal Playwright environment, so auth handled by your existing `playwright.config.ts` (e.g. global setup, storage state, login fixtures) Just Works. Claudia doesn't replace your auth setup — it reuses it.

A future release will add pluggable auth recipes (Clerk/Auth0/NextAuth/Supabase/Cognito starters); until then teams with auth already wired for pre-deploy E2E can adopt `claudia run` today by pointing it at production.

### Where the result surfaces

`claudia run` auto-detects reporting destinations from context. All three skip silently when not applicable:

| Destination | When it fires |
|---|---|
| **`$GITHUB_STEP_SUMMARY`** | Inside GitHub Actions. Markdown report appears in the workflow run's Summary tab. |
| **Sticky PR comment** on the merged PR | `GITHUB_REPOSITORY` set + the deployed SHA has an associated PR. The PR grows a `<!-- claudia:verify -->` sticky comment that updates in place on subsequent deploys. |
| **Slack** | `--slack-webhook <url>` flag or `CLAUDIA_SLACK_WEBHOOK` env. POSTs the markdown to an incoming webhook. |

Disable individually with `--no-step-summary` / `--no-pr-comment`, or omit the Slack flag/env.

**Why PR back-comments matter for merge-to-main flows:** even when deploys happen post-merge (so there's no open PR at deploy time), the merged PR remains the durable record of the change. claudia finds it via `GET /repos/{owner}/{repo}/commits/{sha}/pulls` and posts the verification result there — closing the loop without requiring an open PR.

## Status

v0.9 — Mission A map foundation complete (routes, endpoints, infra, DB schema, spec coverage). PR-time plan-only advisor stable; post-deploy verification primitive (`claudia select`) just landed. Next.js App Router + Terraform + Prisma + Playwright/Cypress. Other frameworks/ORMs are incremental.

## Releases

Versioning and tagging are automated via [release-please](https://github.com/googleapis/release-please) on push to `main`.

- Use **conventional commits** — `feat:`, `fix:`, `docs:`, `refactor:`, etc. Breaking changes: `feat!:` or a `BREAKING CHANGE:` footer.
- release-please opens a "Release PR" that bumps versions in every `package.json` and updates `CHANGELOG.md`.
- Merging the Release PR creates a `v0.x.y` git tag, a GitHub Release, and force-moves the `v0` major tag so `uses: pretorian-worx/runclaudia@v0` always points at the latest 0.x.

If the action's bundle (`packages/github-action/dist/`) is stale, CI will fail. Run `pnpm --filter @claudia/github-action build` and commit the result before pushing.
