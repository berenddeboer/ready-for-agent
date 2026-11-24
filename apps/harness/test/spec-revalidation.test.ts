import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { makeFileDatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { IssueReconcilerLive } from "@ready-for-agent/issue-reconciler"
import { disabledKeymaxxerLayer } from "@ready-for-agent/keymaxxer-service"
import { LinearService } from "@ready-for-agent/linear-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleStepsLive,
  SharedAgentTurnAdmissionLive,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  readSpecWaiverOptions,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitLabServiceLayer,
} from "@ready-for-agent/work-item-lifecycle"
import { specCloseOutTracker } from "@ready-for-agent/work-item-lifecycle/test/spec-close-out-tracker"
import { refreshLoadedRepository } from "../src/server/repository-refresh.js"
import { expect, it } from "bun:test"

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stderr: "pipe", stdout: "pipe" },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const waiver =
  "As Spec owner, I am dropping the hosted MCP requirement from the approved delivery. Local MCP is still required."
const rejectedApproach =
  "Do not use that gateway approach. Hosted MCP is still required."
const duplicate =
  "Closing as a duplicate: the other change delivers hosted MCP."
const question =
  "Does the local requirement include this variant, or is it no longer required?"
const operatorWaiver =
  "I am explicitly dropping the local MCP requirement from this Spec. The hosted requirement still applies."

it.each(
  (["github", "linear"] as const).flatMap((tracker) =>
    (
      [
        "fixed",
        "waived",
        "duplicate",
        "repeated",
        "unclear",
        "regression",
        "mixed",
      ] as const
    ).map((scenario) => ({ tracker, scenario })),
  ),
)(
  "$tracker: revalidates the whole Spec after native follow-ups close ($scenario)",
  async ({ tracker, scenario }) => {
    const root = await mkdtemp(join(tmpdir(), "spec-revalidation-"))
    const specUrl =
      tracker === "linear"
        ? "https://linear.app/acme/issue/ENG-7"
        : "https://github.com/acme/widgets/issues/7"
    const native = specCloseOutTracker(specUrl, {
      title: "MCP delivery",
      description: "Local and deployed MCP must accept initialize.",
    })
    let localWorks = true
    let deployedWorks = false
    let claimInventedAnswer = false
    let commentUrl: string | undefined
    const mcp = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const works =
          new URL(request.url).pathname === "/local/mcp"
            ? localWorks
            : deployedWorks
        if (!works) return new Response(null, { status: 404 })
        return request.method === "POST" &&
          (await request.json()).method === "initialize"
          ? Response.json({ result: { protocolVersion: "2025-03-26" } })
          : new Response(null, { status: 400 })
      },
    })
    const probe = (environment: "local" | "deployed") =>
      Effect.promise(async () => {
        const url = new URL(`${environment}/mcp`, mcp.url)
        const response = await fetch(url, {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        })
        const met = (await response.text()).includes("protocolVersion")
        return {
          requirementId: `mcp-${environment}`,
          requirement: `${environment} MCP accepts initialize`,
          environment,
          status: met ? "met" : "unmet",
          evidence: [
            {
              environment,
              kind: met ? "delivery" : "defect",
              detail: `POST ${url.pathname} → HTTP ${response.status}`,
              ...(met ? {} : { gapId: "initialize-route" }),
            },
          ],
          followUps: met
            ? []
            : [
                {
                  gapId: "initialize-route",
                  kind: "fix",
                  owner: environment === "local" ? "human" : "agent",
                  title: `Restore ${environment} MCP`,
                  task: `Restore the ${environment} route.`,
                  acceptanceCheck: `POST ${url.pathname} returns a protocolVersion.`,
                },
              ],
        }
      })
    let sessions = 0
    const validate = (
      turn: Parameters<typeof AgentBackend.Service.startTurn>[0],
      sessionId: string,
    ) =>
      Effect.gen(function* () {
        yield* (turn.onSessionId?.(sessionId) ?? Effect.void).pipe(Effect.orDie)
        const local = yield* probe("local")
        const deployed = yield* probe("deployed")
        const closingConversation =
          commentUrl !== undefined && turn.prompt.includes(commentUrl)
        const findings = [
          scenario === "mixed" && localWorks
            ? {
                ...local,
                status: "unverified",
                evidence: [
                  {
                    kind: "unavailable",
                    environment: "local",
                    detail: "Unclear whether local includes this variant.",
                  },
                ],
                amendment: { kind: "possible-waiver" },
              }
            : local,
          claimInventedAnswer
            ? {
                ...deployed,
                amendment: { kind: "operator-answer", quote: operatorWaiver },
              }
            : closingConversation &&
                (scenario === "waived" || scenario === "unclear")
              ? {
                  ...deployed,
                  amendment: {
                    kind: "tracker-comment",
                    url: commentUrl,
                    quote: waiver,
                    authorshipEvidence:
                      "The closing conversation attributes the decision to the Spec owner.",
                  },
                }
              : deployed,
        ]
        return {
          sessionId,
          assistantText: `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify(
            scenario === "mixed" && localWorks
              ? {
                  kind: "decision_needed",
                  question,
                  evidence: [
                    "The local decision is ambiguous independently of the hosted 404.",
                  ],
                  findings,
                }
              : findings,
          )}`,
        }
      })

    const database = makeFileDatabaseTest(join(root, "db.sqlite"))
    const layers = () =>
      Layer.merge(WorkItemLifecycleLive, IssueReconcilerLive).pipe(
        Layer.provideMerge(LifecycleStepsLive),
        Layer.provideMerge(SharedAgentTurnAdmissionLive),
        Layer.provideMerge(
          stubActiveAgentBackendLayer({
            startTurn: (_id, turn) => validate(turn, `validator-${++sessions}`),
            continueTurn: (_id, turn) => validate(turn, turn.sessionId),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentBackend, {
            startTurn: () => Effect.die("Expected the captured backend"),
            continueTurn: () => Effect.die("Expected the captured backend"),
            inspect: () => Effect.die("Unexpected backend inspection"),
          }),
        ),
        Layer.provideMerge(disabledKeymaxxerLayer),
        Layer.provideMerge(Layer.succeed(GitHubService, native.github)),
        Layer.provideMerge(Layer.succeed(LinearService, native.linear)),
        Layer.provideMerge(stubGitLabServiceLayer()),
        Layer.provideMerge(stubAzureDevOpsServiceLayer()),
        Layer.provideMerge(BunServices.layer),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(SqliteQueueServiceLive),
        Layer.provideMerge(database),
      )
    const run = (id: string, step: string) =>
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const item = yield* lifecycle.getWorkItem(id)
        const queued = item.stepRuns.find(
          (entry) => entry.step === step && entry.status === "queued",
        )
        expect(queued).toBeDefined()
        if (queued) yield* lifecycle.runStep(queued.id)
        return yield* lifecycle.getWorkItem(id)
      })
    try {
      git(root, "init", "-b", "main", "origin")
      const origin = join(root, "origin")
      git(origin, "commit", "--allow-empty", "-m", "initial delivery")
      git(root, "clone", "--bare", origin, "fixture.git")
      const first = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService
          const lifecycle = yield* WorkItemLifecycle
          yield* db.updateConfig({
            ...(yield* db.getConfig),
            defaultModel: "opencode/test",
            reviewModel: "opencode/test",
          })
          const paused = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: join(root, "fixture.git"),
            isBare: true,
          })
          const repository =
            tracker === "github"
              ? yield* db.unpauseRepository(paused.id)
              : yield* db.updateRepositorySettings({
                  ...paused,
                  repositoryId: paused.id,
                  paused: false,
                  issueTracker: "linear",
                  linearProjectId: "validation-project",
                  linearWorkflowStatuses: [
                    {
                      teamId: "team",
                      teamKey: "ENG",
                      teamName: "Engineering",
                      inProgressStateId: "started",
                      inProgressStateName: "In Progress",
                      doneStateId: "done",
                      doneStateName: "Done",
                    },
                  ],
                })
          const poll = refreshLoadedRepository({
            repository,
            githubOperationOrigin: "polling",
          })
          yield* poll
          const [item] = yield* lifecycle.listWorkItemsForRepository(
            repository.id,
          )
          if (!item) throw new Error("Expected a validation Work Item")
          expect(item.origin).toBe("spec_validation")
          yield* run(item.id, "create_worktree")
          const validated = yield* run(item.id, "validate_spec")
          expect(validated.state).toBe(
            scenario === "mixed" ? "needs_human" : "complete",
          )
          expect(native.tracker.closed).toBe(false)
          expect(native.tracker.followUps.size).toBe(1)
          const [child] = native.tracker.followUps.values()
          if (!child) throw new Error("Missing native child")
          expect(child.labelIds).toEqual(["ready-for-agent"])
          expect(native.tracker.comments.join("\n")).toContain(child.url)
          if (scenario === "mixed") {
            expect(native.tracker.comments.join("\n")).toContain(
              "Decision needed",
            )
            expect(native.tracker.comments.join("\n")).toContain(question)
            const decision = validated.stepRuns.at(-1)
            if (!decision) throw new Error("Missing early waiver decision")
            expect(
              readSpecWaiverOptions(decision.reasonDetail).map(
                ({ requirementId }) => requirementId,
              ),
            ).toEqual(["mcp-local"])
            yield* lifecycle.resume(item.id, {
              stepRunId: decision.id,
              requirementIds: ["mcp-local"],
            })
            const held = yield* run(item.id, "validate_spec")
            expect(held.state).toBe("validate_spec")
            expect(held.holdsWorkerSlot).toBe(false)
          }
          yield* poll
          expect(
            (yield* lifecycle.listWorkItemsForRepository(repository.id)).length,
          ).toBe(1)
          expect(native.tracker.closed).toBe(false)
          return { item: validated, repository, child }
        }).pipe(Effect.provide(layers())),
      )

      // The next pass must observe integration again, not trust the first result.
      git(origin, "commit", "--allow-empty", "-m", "follow-up outcome")
      localWorks = scenario !== "regression" && scenario !== "mixed"
      deployedWorks = ["fixed", "duplicate", "regression", "mixed"].includes(
        scenario,
      )
      first.child.state = ["fixed", "regression", "mixed"].includes(scenario)
        ? "completed"
        : "canceled"
      const closureComment =
        scenario === "duplicate"
          ? duplicate
          : scenario === "repeated"
            ? rejectedApproach
            : scenario === "waived" || scenario === "unclear"
              ? waiver
              : "The follow-up is integrated."
      commentUrl = `${first.child.url}#closure`
      first.child.comments.push({
        url: commentUrl,
        body: closureComment,
        // In the unclear case the automated comment uses the same ordinary
        // tracker account as a person. The tracker exposes no bot marker.
        automation: false,
      })

      // Reconstruct the Harness layers against the same durable database.
      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const { repository } = first
          const poll = refreshLoadedRepository({
            repository,
            githubOperationOrigin: "polling",
          })
          yield* Effect.all([poll, poll], { concurrency: 2 })
          const items = yield* lifecycle.listWorkItemsForRepository(
            repository.id,
          )
          expect(items).toHaveLength(scenario === "mixed" ? 1 : 2)
          const item =
            scenario === "mixed"
              ? items[0]
              : items.find(({ id }) => id !== first.item.id)
          if (!item) throw new Error("Expected a second pass")
          if (scenario !== "mixed") yield* run(item.id, "create_worktree")
          let validated = yield* run(item.id, "validate_spec")
          if (scenario === "mixed") {
            expect(validated.sessionId).not.toBeNull()
            expect(validated.sessionId).toBe(first.item.sessionId)
          }
          expect(validated.startingCommitOid).toBe(
            git(origin, "rev-parse", "HEAD"),
          )
          const parent = () => native.tracker.comments.join("\n")
          if (scenario === "waived" || scenario === "unclear") {
            expect(validated.state).toBe("needs_human")
            expect(native.tracker.closed).toBe(false)
            expect(parent()).not.toContain("Spec validation: passed")
            const decision = validated.stepRuns.at(-1)
            if (!decision) throw new Error("Missing waiver decision")
            expect(readSpecWaiverOptions(decision.reasonDetail)).toEqual([
              expect.objectContaining({
                requirementId: "mcp-deployed",
                trackerComment: { url: commentUrl, quote: waiver },
              }),
            ])
            for (const confirmation of [
              { stepRunId: "stale-decision", requirementIds: ["mcp-deployed"] },
              { stepRunId: decision.id, requirementIds: ["mcp-local"] },
            ]) {
              expect(
                (yield* lifecycle
                  .resume(item.id, confirmation)
                  .pipe(Effect.result))._tag,
              ).toBe("Failure")
            }
            if (scenario === "waived") {
              yield* lifecycle.resume(item.id, {
                stepRunId: decision.id,
                requirementIds: ["mcp-deployed"],
              })
            } else {
              // Resume alone is not an operator answer. Even an explicit but
              // invented quote in the next validator report cannot waive it.
              claimInventedAnswer = true
              yield* lifecycle.resume(item.id)
            }
            validated = yield* run(item.id, "validate_spec")
          }
          if (scenario === "repeated" || scenario === "unclear") {
            expect(validated.state).toBe("needs_human")
            expect(parent()).toContain("Decision needed")
            expect(parent()).toContain(first.child.url)
            expect(native.tracker.followUps.size).toBe(1)
            expect(native.tracker.closed).toBe(false)
          } else if (scenario === "regression") {
            expect(validated.state).toBe("complete")
            expect(parent()).toContain("UNMET — local MCP accepts initialize")
            expect(parent()).toContain("MET — deployed MCP accepts initialize")
            expect(
              [...native.tracker.followUps.values()].flatMap(
                ({ labelIds }) => labelIds,
              ),
            ).toEqual(["ready-for-agent", "ready-for-human"])
            expect(native.tracker.closed).toBe(false)
          } else {
            expect(validated.state).toBe("close_issue")
            expect(native.tracker.closed).toBe(false)
            expect((yield* run(item.id, "close_issue")).state).toBe("complete")
            expect(native.tracker.closed).toBe(true)
            if (scenario === "mixed") {
              expect(parent()).toContain(
                "WAIVED (not claimed delivered) — local",
              )
              expect(parent()).toContain(
                "No longer required: local MCP accepts initialize",
              )
              expect(parent()).toContain("Harness operator confirmation")
            } else {
              expect(parent()).toContain("MET — local MCP accepts initialize")
            }
            expect(parent().match(/## Spec validation: passed/g)).toHaveLength(
              1,
            )
            if (scenario === "waived") {
              expect(parent()).toContain(
                "WAIVED (not claimed delivered) — deployed",
              )
              expect(parent()).toContain(waiver)
              expect(parent()).toContain(
                `related tracker comment: ${commentUrl}`,
              )
              expect(parent()).not.toContain("### MET — deployed")
            } else {
              expect(parent()).toContain(
                "MET — deployed MCP accepts initialize",
              )
            }
          }
          yield* poll
          expect(
            yield* lifecycle.listWorkItemsForRepository(repository.id),
          ).toHaveLength(items.length)
        }).pipe(Effect.provide(layers())),
      )
    } finally {
      mcp.stop(true)
      await rm(root, { force: true, recursive: true })
    }
  },
)
