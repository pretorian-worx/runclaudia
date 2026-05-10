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
- uses: pretorian-worx/runclaudia@v0
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The action posts the plan as a sticky PR comment.

## Status

v0.1 — early. Next.js App Router only. Expect rough edges.

## Releases

Versioning and tagging are automated via [release-please](https://github.com/googleapis/release-please) on push to `main`.

- Use **conventional commits** — `feat:`, `fix:`, `docs:`, `refactor:`, etc. Breaking changes: `feat!:` or a `BREAKING CHANGE:` footer.
- release-please opens a "Release PR" that bumps versions in every `package.json` and updates `CHANGELOG.md`.
- Merging the Release PR creates a `v0.x.y` git tag, a GitHub Release, and force-moves the `v0` major tag so `uses: pretorian-worx/runclaudia@v0` always points at the latest 0.x.

If the action's bundle (`packages/github-action/dist/`) is stale, CI will fail. Run `pnpm --filter @claudia/github-action build` and commit the result before pushing.
