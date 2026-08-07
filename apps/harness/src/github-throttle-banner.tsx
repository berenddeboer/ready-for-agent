import { Banner } from "./banner.js"

export function GitHubThrottleBanner({
  retryAt,
}: {
  readonly retryAt: string | null | undefined
}) {
  if (retryAt === undefined || retryAt === null) {
    return null
  }

  return (
    <Banner tone="alarm" tag="GitHub" role="alert">
      {`GitHub is throttling Harness requests until ${new Date(
        retryAt,
      ).toLocaleTimeString()}`}
    </Banner>
  )
}
