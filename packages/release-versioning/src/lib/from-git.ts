import { ConventionalGitClient } from "@conventional-changelog/git-client"
import type { Commit } from "conventional-commits-parser"
import {
  type NextVersion,
  computeNextVersionFromParsedCommits,
  releaseVersioningParserOptions,
} from "./compute-next-version.js"

export async function computeNextVersionFromGit(
  cwd: string = process.cwd(),
): Promise<NextVersion> {
  const git = new ConventionalGitClient(cwd)
  const lastTag = await git.getLastSemverTag()
  const commits: Commit[] = []

  for await (const commit of git.getCommits(
    {
      from: lastTag ?? "",
      merges: false,
      format: "%B%n-hash-%n%H",
      filterReverts: true,
    },
    releaseVersioningParserOptions(),
  )) {
    commits.push(commit)
  }

  return computeNextVersionFromParsedCommits(lastTag, commits)
}
