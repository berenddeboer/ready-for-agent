import { Schema } from "effect"

const marker = "ready-for-agent:spec-requirement-checklist:v1"
export const SpecRequirementEnvironment = Schema.Literals([
  "local",
  "deployed",
  "other",
])
const Requirement = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
  requirement: Schema.NonEmptyString.check(Schema.isTrimmed()),
  environment: SpecRequirementEnvironment,
})
const Requirements = Schema.NonEmptyArray(Requirement).check(
  Schema.makeFilter(
    (rows) =>
      new Set(rows.map(({ id }) => id)).size === rows.length ||
      "Checklist requirement IDs must be unique",
  ),
)
const ChecklistContent = Schema.Struct({
  baselineUrl: Schema.String.check(Schema.isPattern(/^https:\/\/[^\s<>]+$/u)),
  requirements: Requirements,
})
const ChecklistJson = Schema.fromJsonString(ChecklistContent)
export const ApprovedSpecRequirementChecklist = Schema.Struct({
  ...ChecklistContent.fields,
  sourceUrl: Schema.NonEmptyString,
})
export type ApprovedSpecRequirementChecklist =
  typeof ApprovedSpecRequirementChecklist.Type

export const renderSpecRequirementChecklist = (input: unknown): string => {
  const checklist = Schema.decodeUnknownSync(ChecklistContent)(input)
  return `${marker}\n\n\`\`\`json\n${Schema.encodeSync(ChecklistJson)(checklist)}\n\`\`\`\n`
}

export const readSpecRequirementChecklist = (
  comment: {
    readonly url: string
    readonly body: string
    readonly edited: boolean
  },
  baselineUrl: string,
): ApprovedSpecRequirementChecklist | undefined => {
  if (comment.edited) return undefined
  const [header, fence, json, closing, ...rest] = comment.body
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
  if (
    header !== marker ||
    fence !== "```json" ||
    closing !== "```" ||
    rest.length > 0
  ) {
    return undefined
  }
  const decoded = Schema.decodeUnknownOption(ChecklistJson)(json)
  return decoded._tag === "Some" && decoded.value.baselineUrl === baselineUrl
    ? { ...decoded.value, sourceUrl: comment.url }
    : undefined
}
