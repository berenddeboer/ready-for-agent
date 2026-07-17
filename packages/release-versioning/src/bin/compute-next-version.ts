import {
  InvalidVersionError,
  NothingToReleaseError,
  computeNextVersionFromGit,
} from "../index.js"

const cwd = process.argv[2] ?? process.cwd()

try {
  const next = await computeNextVersionFromGit(cwd)
  process.stdout.write(`${next.version}\n`)
} catch (error) {
  if (error instanceof NothingToReleaseError) {
    console.error(error.message)
    process.exitCode = 1
  } else if (error instanceof InvalidVersionError) {
    console.error(error.message)
    process.exitCode = 1
  } else {
    console.error(error)
    process.exitCode = 1
  }
}
