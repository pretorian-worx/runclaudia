# @pretorian-worx/runclaudia-cli

The CLI for [claudia](https://github.com/pretorian-worx/runclaudia) — a diff-aware post-deploy test agent. Picks the relevant subset of your Playwright suite for a given diff, runs it against the deployed production URL, and reports the result to GitHub Actions, the merged PR, and Slack.

## Install

No install needed for CI usage — invoke via npx:

```bash
npx -y @pretorian-worx/runclaudia-cli <subcommand> [args]
```

For local use:

```bash
npm i -g @pretorian-worx/runclaudia-cli
claudia <subcommand> [args]
```

## Subcommands

- `claudia plan` — diff-aware test plan generation (uses Anthropic)
- `claudia map` — build/inspect the route + endpoint + infra + DB + spec map
- `claudia select` — pick a diff-relevant subset of Playwright/Cypress specs
- `claudia run` — `select` + execute the subset against a deployed URL
- `claudia ratings` — aggregate 👍/👎 reactions across PR plan comments

`claudia plan` requires `ANTHROPIC_API_KEY` in the environment. All other subcommands are deterministic local code (zero API calls).

## Post-deploy verification

This is the canonical use:

```bash
npx -y @pretorian-worx/runclaudia-cli run \
  --base $LAST_DEPLOY_SHA \
  --head $JUST_DEPLOYED_SHA \
  --target https://app.example.com \
  --slack-webhook $SLACK_WEBHOOK_URL
```

Result is auto-reported to:
- `$GITHUB_STEP_SUMMARY` when running in GitHub Actions
- A sticky comment on the merged PR that introduced the deployed commit
- Slack (if `--slack-webhook` or `CLAUDIA_SLACK_WEBHOOK` is set)

See the [main repo README](https://github.com/pretorian-worx/runclaudia#readme) for the full workflow example and the larger product context.

## License

MIT
