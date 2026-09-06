import { CLI_SCHEMA_VERSION } from "../cli-json.ts"
import {
  SKILL_CATALOG,
  type SkillRecord,
  availableSkillIdsList,
  normalizeSkillDocument,
} from "./catalog.ts"

export type SkillListEntry = Pick<
  SkillRecord,
  "id" | "summary" | "mediaType" | "effect" | "safety"
>

export type SkillsListDocument = {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION
  readonly command: "skills"
  readonly version: string
  readonly skills: readonly SkillListEntry[]
}

export type SkillsGetDocument = {
  readonly schemaVersion: typeof CLI_SCHEMA_VERSION
  readonly command: "skills"
  readonly version: string
  readonly skill: SkillListEntry & { readonly content: string }
}

const toListEntry = (skill: SkillRecord): SkillListEntry => ({
  id: skill.id,
  summary: skill.summary,
  mediaType: skill.mediaType,
  effect: skill.effect,
  safety: skill.safety,
})

export const buildSkillsListDocument = (
  version: string,
): SkillsListDocument => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  command: "skills",
  version,
  skills: SKILL_CATALOG.map(toListEntry),
})

export const buildSkillsGetDocument = (input: {
  readonly version: string
  readonly skill: SkillRecord
  readonly content: string
}): SkillsGetDocument => ({
  schemaVersion: CLI_SCHEMA_VERSION,
  command: "skills",
  version: input.version,
  skill: {
    ...toListEntry(input.skill),
    content: input.content,
  },
})

export const renderSkillsListMarkdown = (version: string): string => {
  const rows = SKILL_CATALOG.map(
    (skill) => `| \`${skill.id}\` | ${skill.summary} | ${skill.effect} |`,
  ).join("\n")
  return normalizeSkillDocument(`# Ready for Agent skills

Served by ready-for-agent ${version}. Load one with \`ready-for-agent skills get <skill-id>\`. Start with \`core\`.

| ID | Summary | Effect |
| --- | --- | --- |
${rows}
`)
}

export const unknownSkillMessage = (skillId: string): string =>
  `Unknown skill "${skillId}". Available: ${availableSkillIdsList()}. Run \`ready-for-agent skills list\`.`
