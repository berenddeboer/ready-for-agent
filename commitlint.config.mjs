export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "scope-not-ci": ({ scope }) => [
          scope?.toLowerCase() !== "ci",
          "Use `ci:` as the type for CI changes, not `ci` as a scope.",
        ],
      },
    },
  ],
  rules: {
    "scope-not-ci": [2, "always"],
    // Canonical publication copy is reviewer Markdown, not wrapped 72/100-column
    // commit prose. Semantic Conventional Commit rules stay in force.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
}
