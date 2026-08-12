export const startWorkBannerMessage = ({
  error,
  fallback,
}: {
  readonly error: unknown
  readonly fallback: string
}): string =>
  error instanceof Error && error.message !== "" ? error.message : fallback
