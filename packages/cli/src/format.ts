// Compatibility re-export. The real renderers moved to @pretorian-worx/runclaudia-core in v0.11
// so the GitHub Action can import them without reaching into the CLI's dist/.
// New code should import directly from "@pretorian-worx/runclaudia-core".
export { formatPlanMarkdown as formatMarkdown, formatPlanJson as formatJson } from "@pretorian-worx/runclaudia-core";
