import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import type { AgentBackend } from "@ready-for-agent/agent-backend"
import { Opencode } from "@ready-for-agent/opencode"

export const withOpenCodeHandoffReplay = async <A>(
  input: {
    readonly sessionId: string
    readonly reply: readonly string[]
    readonly backgroundReplies: readonly string[]
    readonly toolStepText?: string
    readonly resumeReply?: readonly string[]
  },
  use: (replay: {
    readonly cwd: string
    readonly layer: Layer<AgentBackend>
    readonly prompts: () => Promise<string[]>
  }) => Promise<A>,
): Promise<A> => {
  const cwd = await mkdtemp(join(tmpdir(), "rfa-handoff-replay-"))
  const binary = join(cwd, "opencode")
  const promptsFile = join(cwd, "prompts.json")
  try {
    // Replay the V2 CLI and export, including a background reply produced
    // after the answer but before an idle boundary is recorded.
    await writeFile(
      binary,
      `#!/usr/bin/env bun
const [command, action] = process.argv.slice(2)
const promptsFile = ${JSON.stringify(promptsFile)}
const prompts = await Bun.file(promptsFile).json()
const scenario = ${JSON.stringify(input)}
const sessionID = scenario.sessionId
const textPart = (text) => ({type: "text", text})
const assistant = (id, content, finish = "stop") => ({
  type: "assistant", id, finish, time: {created: 1, completed: 1}, content,
})
const user = (id, text) => ({type: "user", id, text, time: {created: 1}})
const idle = (id) => ({type: "idle", id, outcome: "succeeded", time: {created: 1}})
const messages = (prompt, index) => {
  const id = String(index)
  const reply = index === 0 ? scenario.reply : scenario.resumeReply ?? ["READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"]
  return [
    user("prompt-" + id, prompt),
    assistant(
      "tool-" + id,
      [textPart(scenario.toolStepText ?? "Inspecting the failure."), {type: "tool", executed: false}],
      scenario.toolStepText === undefined ? "stop" : "tool-calls",
    ),
    assistant("reply-" + id, reply.map(textPart)),
    ...scenario.backgroundReplies.flatMap((text, job) => [
      {type: "synthetic", id: "notice-" + id + "-" + job, metadata: {source: "shell"},
        text: "Background tests completed.", time: {created: 1}},
      assistant("background-" + id + "-" + job, [textPart(text)]),
    ]),
    idle("idle-" + id),
  ]
}
if (command === "run") {
  const prompt = await Bun.stdin.text()
  const index = prompts.length
  await Bun.write(promptsFile, JSON.stringify([...prompts, prompt]))
  for (const message of messages(prompt, index)) {
    if (message.type !== "assistant") continue
    for (const [i, part] of message.content.entries()) {
      if (part.type !== "text") continue
      console.log(JSON.stringify({type: "text", sessionID,
        part: {...part, messageID: message.id, id: message.id + "-" + i}}))
    }
    console.log(JSON.stringify({type: "step_finish", sessionID,
      part: {type: "step-finish", messageID: message.id, reason: message.finish}}))
  }
} else if (command === "session" && action === "export") {
  console.log(JSON.stringify({info: {id: sessionID}, messages: [
    user("prior-prompt", "An earlier unrelated turn"),
    assistant("prior-reply", [textPart("READY_FOR_AGENT_RESULT: PROCESSED")]),
    idle("prior-idle"),
    ...prompts.flatMap(messages),
  ]}))
} else {
  process.exit(9)
}
`,
    )
    await chmod(binary, 0o700)
    await writeFile(promptsFile, "[]")
    return await use({
      cwd,
      layer: Opencode.layer({ binary }).pipe(
        Layer.provide(BunServices.layer),
        Layer.orDie,
      ),
      prompts: async () => {
        const value: unknown = await Bun.file(promptsFile).json()
        if (!Array.isArray(value)) throw new Error("Invalid prompt replay")
        return value.filter((text): text is string => typeof text === "string")
      },
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
