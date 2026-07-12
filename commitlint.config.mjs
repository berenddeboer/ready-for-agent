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
  },
}
