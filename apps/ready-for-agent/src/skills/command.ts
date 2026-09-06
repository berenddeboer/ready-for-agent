import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { FiniteCommandFailed, encodeCompactJson } from "../cli-json.ts"
import { READY_FOR_AGENT_VERSION } from "../generated/version.ts"
import { SKILL_CATALOG, findSkill, normalizeSkillDocument } from "./catalog.ts"
import {
  buildSkillsGetDocument,
  buildSkillsListDocument,
  renderSkillsListMarkdown,
  unknownSkillMessage,
} from "./documents.ts"

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print a versioned JSON document"),
)

const skillIdArg = Argument.string("skill-id").pipe(
  Argument.withDescription(
    `Stable skill identifier from \`skills list\` (${SKILL_CATALOG.map((skill) => skill.id).join(", ")})`,
  ),
)

const writeStdout = (text: string) =>
  Effect.sync(() => {
    process.stdout.write(text)
  })

const skillsListWorkflow = Effect.fn("Cli.skillsList")(function* (
  json: boolean,
) {
  if (json) {
    yield* Console.log(
      encodeCompactJson(buildSkillsListDocument(READY_FOR_AGENT_VERSION)),
    )
    return
  }
  yield* writeStdout(renderSkillsListMarkdown(READY_FOR_AGENT_VERSION))
})

const skillsGetWorkflow = Effect.fn("Cli.skillsGet")(function* (
  skillId: string,
  json: boolean,
) {
  const skill = findSkill(skillId)
  if (skill === undefined) {
    return yield* new FiniteCommandFailed({
      command: "skills",
      code: "SKILL_NOT_FOUND",
      message: unknownSkillMessage(skillId),
    })
  }
  const content = normalizeSkillDocument(skill.render(READY_FOR_AGENT_VERSION))
  if (json) {
    yield* Console.log(
      encodeCompactJson(
        buildSkillsGetDocument({
          version: READY_FOR_AGENT_VERSION,
          skill,
          content,
        }),
      ),
    )
    return
  }
  yield* writeStdout(content)
})

const skillsListCommand = Command.make("list", { json: jsonFlag }, ({ json }) =>
  skillsListWorkflow(json),
).pipe(
  Command.withDescription(
    "List bundled agent skills matching this CLI version",
  ),
)

const skillsGetCommand = Command.make(
  "get",
  { skillId: skillIdArg, json: jsonFlag },
  ({ skillId, json }) => skillsGetWorkflow(skillId, json),
).pipe(
  Command.withDescription(
    "Print one bundled skill as Markdown (or a versioned JSON document with --json)",
  ),
)

export const skillsCommand = Command.make(
  "skills",
  { json: jsonFlag },
  ({ json }) => skillsListWorkflow(json),
).pipe(
  Command.withDescription(
    "Discover version-matched agent skills bundled with this CLI (offline; aliases skills list)",
  ),
  Command.withSubcommands([skillsListCommand, skillsGetCommand]),
)
