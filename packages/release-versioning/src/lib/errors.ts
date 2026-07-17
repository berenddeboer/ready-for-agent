export class NothingToReleaseError extends Error {
  override readonly name = "NothingToReleaseError"

  constructor(
    message = "Nothing to release: no conventional commits since the last release tag.",
  ) {
    super(message)
  }
}

export class InvalidVersionError extends Error {
  override readonly name = "InvalidVersionError"

  constructor(version: string) {
    super(`Invalid last version: ${version}`)
  }
}
