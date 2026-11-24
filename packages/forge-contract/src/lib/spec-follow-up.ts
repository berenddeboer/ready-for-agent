import { Schema } from "effect"

export const SpecGapId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
)

const GapIdentity = {
  requirementId: Schema.NonEmptyString,
  gapId: SpecGapId,
}
export const SpecFollowUp = Schema.Struct({
  ...GapIdentity,
  title: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
  label: Schema.Literals(["ready-for-agent", "ready-for-human"]),
})

export const SpecFollowUpPublication = Schema.Struct({
  parentId: Schema.NonEmptyString,
  parentUrl: Schema.NonEmptyString,
  workItemId: Schema.NonEmptyString,
  findings: Schema.NonEmptyString,
  children: Schema.NonEmptyArray(SpecFollowUp),
})
export type SpecFollowUpPublication = typeof SpecFollowUpPublication.Type

export const PublishedSpecFollowUps = Schema.Array(
  Schema.Struct({
    ...GapIdentity,
    nativeId: Schema.optionalKey(Schema.NonEmptyString),
    url: Schema.NonEmptyString,
  }),
)
export type PublishedSpecFollowUps = typeof PublishedSpecFollowUps.Type

export const specFollowUpMarker = (
  parentId: string,
  requirementId: string,
  gapId: string,
) =>
  `<!-- ready-for-agent:spec-follow-up:${parentId}:${requirementId}:${gapId} -->`

export const specFindingsMarker = (workItemId: string) =>
  `ready-for-agent:spec-findings:${workItemId}`

export const formatSpecFollowUpLinks = (links: PublishedSpecFollowUps) =>
  links.length === 0
    ? ""
    : [
        "### Native follow-ups",
        ...links.map(
          ({ requirementId, gapId, url }) =>
            `- [${requirementId}: ${gapId}](<${url}>)`,
        ),
      ].join("\n")

export const formatSpecFollowUpComment = (
  input: SpecFollowUpPublication,
  links: PublishedSpecFollowUps,
) => {
  const pending = input.children.filter(
    ({ requirementId, gapId }) =>
      !links.some(
        (link) => link.requirementId === requirementId && link.gapId === gapId,
      ),
  )
  return [
    "## Spec validation findings",
    input.findings,
    formatSpecFollowUpLinks(links),
    ...(pending.length === 0
      ? []
      : [
          [
            "### Follow-ups not yet published",
            ...pending.map(
              ({ requirementId, gapId }) => `- ${requirementId}: ${gapId}`,
            ),
          ].join("\n"),
        ]),
    "The Spec remains open. Open follow-ups block further validation.",
    specFindingsMarker(input.workItemId),
  ].join("\n\n")
}
