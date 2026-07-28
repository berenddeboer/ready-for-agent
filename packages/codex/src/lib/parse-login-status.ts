export type CodexLoginStatus =
  | { readonly kind: "authenticated" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "malformed" }
  | { readonly kind: "failed"; readonly exitCode: number }

/**
 * Real CLI status phrases (stderr via eprintln!) and compatible test fakes.
 * Primary form is "Logged in using …" / "Not logged in".
 */
// Matches real CLI: "Logged in using ChatGPT", "Logged in using an API key - …"
const AUTHENTICATED_MARKERS = [/logged in using/i]

const UNAUTHENTICATED_MARKERS = [
  /not logged in/i,
  /you are not authenticated/i,
  /authentication required/i,
  /please (?:log|sign) in/i,
]

/**
 * Interpret `codex login status` captured text (stdout and/or stderr) plus
 * exit code into readiness.
 *
 * Real CLI: authenticated exits 0 with "Logged in using …" on stderr;
 * unauthenticated exits 1 with "Not logged in" on stderr. Classification is
 * marker-driven so a non-zero crash or unexpected exit is not mistaken for
 * missing auth.
 */
export const parseCodexLoginStatus = (
  output: string,
  exitCode: number,
): CodexLoginStatus => {
  if (UNAUTHENTICATED_MARKERS.some((marker) => marker.test(output))) {
    return { kind: "unauthenticated" }
  }
  if (AUTHENTICATED_MARKERS.some((marker) => marker.test(output))) {
    return { kind: "authenticated" }
  }
  if (exitCode !== 0) {
    return { kind: "failed", exitCode }
  }
  return { kind: "malformed" }
}
