# @pretorian-worx/runclaudia-core

Programmatic core for [claudia](https://github.com/pretorian-worx/runclaudia) — the diff parser, framework adapters (Next.js App Router, Terraform, Prisma, Playwright/Cypress), prompt builder, Anthropic SDK wrapper, plan/selection/gating/runner primitives.

This package is consumed by:

- [`@pretorian-worx/runclaudia-cli`](https://www.npmjs.com/package/@pretorian-worx/runclaudia-cli) — the CLI most users invoke via `npx`
- The runclaudia GitHub Action (`uses: pretorian-worx/runclaudia@v0`)

You can also use it directly from your own Node code if you need to wire claudia into a custom CI pipeline or write a different reporter — e.g. `import { runSelect, buildPlaywrightCommand } from "@pretorian-worx/runclaudia-core"`.

For the full product documentation, see the [main repo README](https://github.com/pretorian-worx/runclaudia#readme).

## License

MIT
