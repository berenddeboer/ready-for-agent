import createPreset from "conventional-changelog-conventionalcommits"
import {
  type Commit,
  CommitParser,
  type ParserOptions,
} from "conventional-commits-parser"
import semver from "semver"
import { InvalidVersionError, NothingToReleaseError } from "./errors.js"

const RELEASE_TYPES = ["major", "minor", "patch"] as const

export type ReleaseType = (typeof RELEASE_TYPES)[number]

export type ComputeNextVersionInput = {
  lastVersion: string | null
  commitMessages: readonly string[]
}

export type NextVersion = {
  version: string
  releaseType: ReleaseType
  reason: string
}

const FIRST_PUBLIC_VERSION = "0.1.0"

type WhatBumpResult = { level: 0 | 1 | 2; reason: string } | null | undefined

type Preset = {
  parser: ParserOptions
  whatBump: (commits: Commit[]) => WhatBumpResult
}

function loadPreset(): Preset {
  return createPreset({ preMajor: false }) as Preset
}

export function computeNextVersion(
  input: ComputeNextVersionInput,
): NextVersion {
  const preset = loadPreset()
  const parser = new CommitParser(preset.parser)
  const commits = input.commitMessages.map((message) => parser.parse(message))
  return nextVersionFromParsed(input.lastVersion, commits, preset.whatBump)
}

export function computeNextVersionFromParsedCommits(
  lastVersion: string | null,
  commits: readonly Commit[],
): NextVersion {
  return nextVersionFromParsed(lastVersion, commits, loadPreset().whatBump)
}

function nextVersionFromParsed(
  lastVersion: string | null,
  commits: readonly Commit[],
  whatBump: (commits: Commit[]) => WhatBumpResult,
): NextVersion {
  const recommendation = whatBump([...commits])

  if (recommendation == null || !("level" in recommendation)) {
    throw new NothingToReleaseError()
  }

  const releaseType = RELEASE_TYPES[recommendation.level]
  if (releaseType === undefined) {
    throw new NothingToReleaseError()
  }

  if (lastVersion == null || lastVersion === "") {
    return {
      version: FIRST_PUBLIC_VERSION,
      releaseType,
      reason: `First public version (${recommendation.reason})`,
    }
  }

  const cleaned = semver.clean(lastVersion)
  if (cleaned === null) {
    throw new InvalidVersionError(lastVersion)
  }

  const version = semver.inc(cleaned, releaseType)
  if (version === null) {
    throw new InvalidVersionError(lastVersion)
  }

  return {
    version,
    releaseType,
    reason: recommendation.reason,
  }
}

export function releaseVersioningParserOptions(): ParserOptions {
  return loadPreset().parser
}
