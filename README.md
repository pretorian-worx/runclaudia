# claudia

Diff-aware post-deploy test agent. Reads a git diff, infers which user-facing flows were affected, and posts a structured test plan to the PR.

**v1 is plan-only.** No browser, no auth, no execution. The CLI tells you what *should* be tested; a human (for now) decides whether to run it.

## Why

Most teams ship code and skip the manual prod check. Full E2E suites are too slow to gate every deploy, so coverage drops to "did the build succeed." This agent closes that gap by giving every PR a focused, diff-scoped test plan in <60 seconds.

The plan-only stage exists to validate the diff→flow inference before we take on the harder runtime, auth, and flake problems. See [`ROADMAP.md`](./ROADMAP.md) for stages B (generate + run) and C (smart test selector).

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
- uses: claudia-dev/claudia-action@v0
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action posts the plan as a sticky PR comment.

## Status

v0.1 — early. Next.js App Router only. Expect rough edges.
