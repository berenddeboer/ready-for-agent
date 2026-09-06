import coreBody from "./content/core.md" with { type: "text" }
import operatingBody from "./content/operating.md" with { type: "text" }
import recoveryBody from "./content/recovery.md" with { type: "text" }
import reportingBody from "./content/reporting.md" with { type: "text" }
import { renderLifecycleSkill } from "./lifecycle.ts"

export const SKILL_MEDIA_TYPE = "text/markdown" as const

export type SkillId =
  | "core"
  | "reporting"
  | "operating"
  | "recovery"
  | "lifecycle"

export type SkillEffect = "read" | "write" | "destructive"

export type SkillSafety = {
  readonly read: boolean
  readonly write: boolean
  readonly destructive: boolean
  readonly tokenSpending: boolean
  readonly fanOut: boolean
}

export type SkillRecord = {
  readonly id: SkillId
  readonly summary: string
  readonly mediaType: typeof SKILL_MEDIA_TYPE
  readonly effect: SkillEffect
  readonly safety: SkillSafety
  readonly render: (version: string) => string
}

const readSafety = {
  read: true,
  write: false,
  destructive: false,
  tokenSpending: false,
  fanOut: false,
} as const satisfies SkillSafety

const interpolateVersion = (input: {
  readonly body: string
  readonly version: string
}): string => input.body.replaceAll("{{CLI_VERSION}}", input.version)

export const SKILL_CATALOG: readonly SkillRecord[] = [
  {
    id: "core",
    summary:
      "Orientation, skill routing, JSON/exit semantics, and CLI/Harness version mismatch",
    mediaType: SKILL_MEDIA_TYPE,
    effect: "read",
    safety: readSafety,
    render: (version) => interpolateVersion({ body: coreBody, version }),
  },
  {
    id: "reporting",
    summary:
      "Windowed status, lifecycle-attempt semantics, and GraphQL reporting recipes",
    mediaType: SKILL_MEDIA_TYPE,
    effect: "read",
    safety: readSafety,
    render: (version) => interpolateVersion({ body: reportingBody, version }),
  },
  {
    id: "operating",
    summary:
      "Candidates-before-intake, targeted vs autonomous retry, and launching work",
    mediaType: SKILL_MEDIA_TYPE,
    effect: "write",
    safety: {
      read: true,
      write: true,
      destructive: false,
      tokenSpending: true,
      fanOut: true,
    },
    render: (version) => interpolateVersion({ body: operatingBody, version }),
  },
  {
    id: "recovery",
    summary:
      "Diagnosis, reason-code triage, unowned-PR inspection, and irreversible Reset",
    mediaType: SKILL_MEDIA_TYPE,
    effect: "destructive",
    safety: {
      read: true,
      write: true,
      destructive: true,
      tokenSpending: false,
      fanOut: false,
    },
    render: (version) => interpolateVersion({ body: recoveryBody, version }),
  },
  {
    id: "lifecycle",
    summary:
      "Work Item states, Step Run reason codes, and step properties from this CLI's ontology",
    mediaType: SKILL_MEDIA_TYPE,
    effect: "read",
    safety: readSafety,
    render: (version) => renderLifecycleSkill(version),
  },
]

export const SKILL_IDS: readonly SkillId[] = SKILL_CATALOG.map(
  (skill) => skill.id,
)

export const findSkill = (id: string): SkillRecord | undefined =>
  SKILL_CATALOG.find((skill) => skill.id === id)

export const availableSkillIdsList = (): string => SKILL_IDS.join(", ")

export const normalizeSkillDocument = (text: string): string => {
  const trimmed = text.replace(/^\uFEFF/, "").replace(/\s+$/, "")
  return `${trimmed}\n`
}
