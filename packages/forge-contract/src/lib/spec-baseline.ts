import { Schema } from "effect"
import {
  ApprovedSpecRequirementChecklist,
  readSpecRequirementChecklist,
} from "./spec-requirement-checklist.js"

export const SPEC_LABEL = "spec"

const marker = "ready-for-agent:spec-baseline:v1"
const archivedBaselineHeading = /^## Approved Spec baseline[ \t]*$/iu
const permalink =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/blob\/[0-9a-f]{40}\/[^<>\s]+$/i
const DesignRevision = Schema.String.pipe(
  Schema.check(Schema.isPattern(permalink)),
)
const SpecText = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  designRevisions: Schema.Array(DesignRevision),
})
const Snapshot = Schema.fromJsonString(SpecText)

export const SpecBaseline = Schema.Struct({
  ...SpecText.fields,
  source: Schema.Struct({
    kind: Schema.Literals([
      "publication-comment",
      "marked-parent",
      "historical-approval-comment",
    ]),
    url: Schema.String,
  }),
  requirementChecklist: Schema.optionalKey(ApprovedSpecRequirementChecklist),
  designRevisionSources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ revision: DesignRevision, commentUrl: Schema.String }),
    ),
  ),
})
export type SpecBaseline = typeof SpecBaseline.Type

export const SpecBaselineResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-spec") }),
  Schema.Struct({
    kind: Schema.Literal("baseline"),
    baseline: SpecBaseline,
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    candidates: Schema.Array(SpecBaseline),
    unreadableSnapshots: Schema.Array(Schema.String),
  }),
])
export type SpecBaselineResult = typeof SpecBaselineResult.Type

interface BaselineComment {
  readonly url: string
  readonly body: string
  readonly edited: boolean
}

const uniqueSorted = (values: readonly string[]) => [...new Set(values)].sort()

function* proseLines(
  lines: readonly string[],
): Generator<readonly [number, string]> {
  const prose = lines.map(() => "")
  const listContentColumns: number[] = []
  let fence: string | undefined
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue
    const indent = line.match(/^ */u)?.[0].length ?? 0
    while ((listContentColumns.at(-1) ?? 0) > indent) {
      listContentColumns.pop()
      fence = undefined
    }
    // Code indentation is relative to the enclosing list item, if any.
    const column = listContentColumns.at(-1) ?? 0
    const content = line.slice(column)
    const listMarker =
      fence === undefined
        ? content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)]) {1,4}(?=\S)/u)?.[0]
        : undefined
    if (listMarker !== undefined) {
      listContentColumns.push(column + listMarker.length)
    }
    const [, delimiter, suffix] =
      content
        .slice(listMarker?.length ?? 0)
        .match(/^ {0,3}(`{3,}|~{3,})(.*)$/u) ?? []
    if (fence !== undefined) {
      if (delimiter?.startsWith(fence) && suffix?.trim() === "") {
        fence = undefined
      }
    } else if (delimiter !== undefined) {
      fence = delimiter
    } else if (!/^(?: {4}| {0,3}[\t>])/u.test(content)) {
      prose[index] = line
    }
  }
  // Keep line indices so an archived section can be sliced from the original.
  const visible = prose
    .join("\n")
    .replace(
      /(?<!`)(`+)(?!`)(?:[^\n]|\n(?![ \t]*\n))*?(?<!`)\1(?!`)|<!--[\s\S]*?(?:-->|$)|<(?<htmlCode>pre|code)(?=[\s>])[^>]*>[\s\S]*?(?:<\/\k<htmlCode>\s*>|$)/giu,
      (example) => example.replace(/[^\n]+/gu, " "),
    )
  yield* visible.split("\n").entries()
}

const archivedApprovalText = (body: string): string | undefined => {
  const lines = body.split(/\r?\n/u)
  let start: number | undefined
  let end = lines.length
  for (const [index, line] of proseLines(lines)) {
    if (start === undefined) {
      if (archivedBaselineHeading.test(line)) start = index + 1
    } else if (/^ {0,3}#{1,2}(?:[ \t]|$)/u.test(line)) {
      end = index
      break
    }
  }
  return start === undefined
    ? undefined
    : lines
        .slice(start, end)
        .join("\n")
        .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/gu, "")
}

const hasConflictingRevisions = (revisions: readonly string[]): boolean => {
  const commits = new Map<string, string>()
  for (const revision of revisions) {
    const [, owner, repo, , commit, ...path] = new URL(revision).pathname.split(
      "/",
    )
    if (owner === undefined || repo === undefined || commit === undefined) {
      continue
    }
    const document = `${owner.toLowerCase()}/${repo.toLowerCase()}/${path.join("/")}`
    const sha = commit.toLowerCase()
    const previous = commits.get(document)
    if (previous !== undefined && previous !== sha) return true
    commits.set(document, sha)
  }
  return false
}

/**
 * Older Specs can identify approved documents in the parent itself. Recover
 * fixed links explicitly designated as approved scope, not arbitrary links or
 * the revision currently at the head of a branch.
 */
const approvedDesignRevisions = (
  body: string,
  includeDesignLinks = false,
): readonly string[] => {
  const revisions: string[] = []
  let designSectionLevel: number | undefined
  for (const [, line] of proseLines(body.split(/\r?\n/u))) {
    const [, heading] = line.match(/^ {0,3}(#{1,6})(?:[ \t]|$)/u) ?? []
    if (heading !== undefined) {
      if (
        designSectionLevel !== undefined &&
        heading.length <= designSectionLevel
      ) {
        designSectionLevel = undefined
      }
      if (
        designSectionLevel === undefined &&
        /^ {0,3}#{2,6} Approved design revisions[ \t]*$/iu.test(line)
      ) {
        designSectionLevel = heading.length
      }
    }
    const inDesignSection = designSectionLevel !== undefined
    if (inDesignSection) {
      const [, bareUrl] =
        line.match(
          /^\s*(?:(?:[-+*]|\d{1,9}[.)])\s+)?<?(https:\/\/[^\s<>()]+)>?\s*$/iu,
        ) ?? []
      if (bareUrl !== undefined && permalink.test(bareUrl)) {
        revisions.push(bareUrl)
      }
    }
    // A pair of backslashes is literal; an odd run escapes the opening bracket.
    for (const [, imageMarker, label, bracketedUrl, bareUrl] of line.matchAll(
      /(?<!\\)(?:\\\\)*(!)?\[([^\]]+)\]\((?:<(https:\/\/github\.com\/[^\s<>()]+)>|(https:\/\/github\.com\/[^\s<>()]+))(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*\)/giu,
    )) {
      if (imageMarker !== undefined) continue
      const url = bracketedUrl ?? bareUrl
      if (
        url !== undefined &&
        permalink.test(url) &&
        (inDesignSection ||
          /^approved design baseline\b/iu.test(label ?? "") ||
          (includeDesignLinks && /^design$/iu.test(label ?? "")))
      ) {
        revisions.push(url)
      }
    }
  }
  return uniqueSorted(revisions)
}

/** Freeze exactly the approved draft, with only explicitly incorporated links. */
export const renderSpecBaseline = (input: typeof SpecText.Type): string => {
  const snapshot = Schema.encodeSync(Snapshot)({
    ...input,
    designRevisions: uniqueSorted(input.designRevisions),
  })
  return `${marker}\n\n\`\`\`json\n${snapshot}\n\`\`\`\n`
}

/**
 * Candidate differences are evidence, not amendments. The validator decides
 * whether they matter to a verdict; it must not pick the newest candidate.
 */
export const resolveSpecBaseline = (
  parent: {
    readonly marked: boolean
    readonly title: string
    readonly body: string
    readonly url: string
  },
  comments: readonly BaselineComment[],
): SpecBaselineResult => {
  if (!parent.marked) return { kind: "not-spec" }

  // Comment formatting identifies an evidence format, not who approved it.
  const citedApprovals = new Set<string>()
  const citedChecklists = new Set<string>()
  for (const [, line] of proseLines(parent.body.split(/\r?\n/u))) {
    for (const [, label, bracketedUrl, bareUrl] of line.matchAll(
      /(?<![!\\])\[(Approved Spec baseline|Approved requirement checklist)\]\((?:<(https:\/\/[^\s<>()]+)>|(https:\/\/[^\s<>()]+))\)/giu,
    )) {
      const url = bracketedUrl ?? bareUrl
      if (url !== undefined) {
        const citations =
          label?.toLowerCase() === "approved spec baseline"
            ? citedApprovals
            : citedChecklists
        citations.add(url)
      }
    }
  }
  const isCited = (candidate: SpecBaseline) =>
    citedApprovals.has(candidate.source.url)
  const markedParent: SpecBaseline = {
    title: parent.title,
    body: parent.body,
    designRevisions: approvedDesignRevisions(parent.body, true),
    source: { kind: "marked-parent", url: parent.url },
  }
  const candidates: SpecBaseline[] = []
  const historicalApprovals: {
    readonly candidate: SpecBaseline
    readonly hasArchivedText: boolean
  }[] = []
  const unreadableSnapshots: string[] = []
  for (const comment of comments) {
    const body = comment.body
    const [header, fence, json, closing, ...rest] = body
      .trim()
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "")
    if (header !== marker) {
      const archivedText = archivedApprovalText(body)
      const designRevisions = approvedDesignRevisions(
        archivedText ?? body,
        archivedText !== undefined,
      )
      const hasArchivedText =
        archivedText !== undefined && archivedText.trim() !== ""
      if (hasArchivedText || designRevisions.length > 0) {
        if (comment.edited) {
          unreadableSnapshots.push(comment.url)
          continue
        }
        historicalApprovals.push({
          hasArchivedText,
          candidate: {
            title: parent.title,
            body: hasArchivedText ? archivedText : body.trim(),
            designRevisions,
            source: { kind: "historical-approval-comment", url: comment.url },
          },
        })
      }
      continue
    }
    const snapshot =
      !comment.edited &&
      (fence === "```json" || fence === "```") &&
      closing === "```" &&
      rest.length === 0
        ? Schema.decodeUnknownOption(Snapshot)(json)
        : undefined
    if (snapshot?._tag !== "Some") {
      unreadableSnapshots.push(comment.url)
      continue
    }
    candidates.push({
      ...snapshot.value,
      designRevisions: uniqueSorted(snapshot.value.designRevisions),
      source: { kind: "publication-comment", url: comment.url },
    })
  }

  for (const url of citedApprovals) {
    if (
      !candidates.some((candidate) => candidate.source.url === url) &&
      !historicalApprovals.some(
        ({ candidate }) => candidate.source.url === url,
      ) &&
      !unreadableSnapshots.includes(url)
    ) {
      unreadableSnapshots.push(url)
    }
  }

  const [checklistUrl] = citedChecklists
  const checklistComment =
    citedChecklists.size === 1
      ? comments.find(({ url }) => url === checklistUrl)
      : undefined
  // Keep the checklist binding even when approval itself needs a decision.
  // A checklist does not choose between conflicting snapshots.
  for (const [index, candidate] of candidates.entries()) {
    const checklist =
      checklistComment &&
      isCited(candidate) &&
      !hasConflictingRevisions(candidate.designRevisions) &&
      readSpecRequirementChecklist(checklistComment, candidate.source.url)
    if (checklist) {
      candidates[index] = { ...candidate, requirementChecklist: checklist }
    }
  }
  const published = candidates.find(isCited)
  if (published !== undefined) {
    // Historical comments never replace a publication snapshot.
    const hasLiveDesignClaim = markedParent.designRevisions.some(
      (revision) => !published.designRevisions.includes(revision),
    )
    const competing = historicalApprovals.filter(
      ({ candidate, hasArchivedText }) =>
        (hasArchivedText && candidate.body.trim() !== published.body.trim()) ||
        candidate.designRevisions.some(
          (revision) => !published.designRevisions.includes(revision),
        ),
    )
    if (
      unreadableSnapshots.length === 0 &&
      competing.length === 0 &&
      !hasLiveDesignClaim &&
      !hasConflictingRevisions(published.designRevisions) &&
      candidates.every(
        (candidate) =>
          candidate.title === published.title &&
          candidate.body === published.body &&
          candidate.designRevisions.join("\n") ===
            published.designRevisions.join("\n"),
      )
    ) {
      return { kind: "baseline", baseline: published }
    }
    return {
      kind: "review",
      candidates: [
        ...candidates,
        ...competing.map(({ candidate }) => candidate),
        ...(hasLiveDesignClaim || unreadableSnapshots.length > 0
          ? [markedParent]
          : []),
      ],
      unreadableSnapshots,
    }
  }

  const archived = historicalApprovals.filter(
    ({ hasArchivedText }) => hasArchivedText,
  )
  const text =
    archived.find(({ candidate }) => isCited(candidate))?.candidate ??
    markedParent
  const historicalCandidates = historicalApprovals.map(
    ({ candidate }) => candidate,
  )
  const evidence = [markedParent, ...candidates, ...historicalCandidates]
  const citedHistorical = historicalCandidates.filter(isCited)
  const designRevisions = uniqueSorted([
    ...text.designRevisions,
    ...citedHistorical.flatMap((candidate) => candidate.designRevisions),
  ])
  if (
    unreadableSnapshots.length > 0 ||
    archived.some(
      ({ candidate }) => candidate.body.trim() !== text.body.trim(),
    ) ||
    candidates.some(
      (candidate) =>
        candidate.title !== text.title ||
        candidate.body.trim() !== text.body.trim() ||
        candidate.designRevisions.join("\n") !== designRevisions.join("\n"),
    ) ||
    // A live-only design link cannot extend an archived approval.
    [markedParent, ...historicalCandidates].some((candidate) =>
      candidate.designRevisions.some(
        (revision) => !designRevisions.includes(revision),
      ),
    ) ||
    hasConflictingRevisions(designRevisions)
  ) {
    return {
      kind: "review",
      candidates: evidence,
      unreadableSnapshots,
    }
  }
  const designRevisionSources = citedHistorical.flatMap((candidate) =>
    candidate.designRevisions.map((revision) => ({
      revision,
      commentUrl: candidate.source.url,
    })),
  )
  return {
    kind: "baseline",
    baseline: {
      ...text,
      designRevisions,
      ...(designRevisionSources.length > 0 ? { designRevisionSources } : {}),
    },
  }
}
