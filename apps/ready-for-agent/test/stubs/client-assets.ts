/**
 * Vitest stub for generated embed assets so Effect unit suites do not load
 * harness `dist/client` HTML/JS as modules (generate-embed output).
 */
export const embeddedClientAssets: Readonly<Record<string, string>> = {}
export const embeddedShellHtmlPath = "index.html"
