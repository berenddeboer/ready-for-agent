import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { makeFileDatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import type {
  ApprovedSpecRequirementChecklist,
  SpecBaselineResult,
  SpecObservation,
} from "@ready-for-agent/forge-contract"
import {
  GitHubRequestError,
  GitHubService,
} from "@ready-for-agent/github-service"
import {
  LinearRequestError,
  LinearService,
  defaultLinearServiceShape,
} from "@ready-for-agent/linear-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  createWorktree,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "../src/index.js"
import { decodeSpecFindings, validateSpec } from "../src/lib/validate-spec.js"
import { expect, it } from "bun:test"

const commit = "a".repeat(40)
const revision = `https://github.com/acme/widgets/blob/${commit}/design.md`
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
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
const approvedChecklist = (
  baselineUrl: string,
): ApprovedSpecRequirementChecklist => ({
  baselineUrl,
  sourceUrl: `${baselineUrl.split("#")[0]}#approved-checklist`,
  requirements: [
    {
      id: "mcp-local",
      environment: "local",
      requirement: "local MCP accepts initialize",
    },
    {
      id: "mcp-deployed",
      environment: "deployed",
      requirement: "deployed MCP accepts initialize",
    },
  ],
})
const no = () =>
  Effect.die(
    "Spec Validation must not run an implementation step, open a follow-up, or close the parent",
  )

const runNext = (workItemId: string, step: string) =>
  Effect.gen(function* () {
    const lifecycle = yield* WorkItemLifecycle
    const item = yield* lifecycle.getWorkItem(workItemId)
    const queued = item.stepRuns.find(
      (run) => run.step === step && run.status === "queued",
    )
    if (!queued) throw new Error(`Missing queued ${step}`)
    yield* lifecycle.runStep(queued.id)
  })

it.each([
  {
    tracker: "linear",
    deployedStatus: 404,
    expected: "UNMET",
    omit: false,
    initialSource: "publication-comment",
  },
  {
    tracker: "linear",
    deployedStatus: 403,
    expected: "UNVERIFIED",
    omit: false,
    initialSource: "publication-comment",
  },
  {
    tracker: "github",
    deployedStatus: 404,
    expected: "UNMET",
    omit: false,
    initialSource: "publication-comment",
  },
  {
    tracker: "github",
    deployedStatus: 403,
    expected: "UNVERIFIED",
    omit: false,
    initialSource: "publication-comment",
  },
  {
    tracker: "linear",
    deployedStatus: 404,
    expected: "UNVERIFIED",
    omit: true,
    initialSource: "publication-comment",
  },
  {
    tracker: "linear",
    deployedStatus: 404,
    expected: "UNVERIFIED",
    omit: true,
    initialSource: "marked-parent",
  },
  {
    tracker: "linear",
    deployedStatus: 404,
    expected: "UNVERIFIED",
    omit: true,
    initialSource: "historical-approval-comment",
  },
  {
    tracker: "linear",
    deployedStatus: 404,
    expected: "UNMET",
    omit: false,
    initialSource: "publication-comment",
    decision: "authorship",
  },
  {
    tracker: "github",
    deployedStatus: 404,
    expected: "UNMET",
    omit: false,
    initialSource: "publication-comment",
    decision: "baseline",
  },
  {
    tracker: "linear",
    deployedStatus: 404,
    expected: "UNMET",
    omit: false,
    initialSource: "publication-comment",
    decision: "changed-baseline",
  },
] as const)(
  "$tracker: records $expected for deployed HTTP $deployedStatus (omitted: $omit, baseline: $initialSource, decision: $decision)",
  async (scenario) => {
    const { tracker, deployedStatus, expected, omit, initialSource } = scenario
    const decision = "decision" in scenario ? scenario.decision : undefined
    const baselineDecision =
      decision === "baseline" || decision === "changed-baseline"
    const waitForChecklist = omit || decision === "changed-baseline"
    const root = await mkdtemp(join(tmpdir(), "spec-validation-"))
    const sessionId = "spec-validator-own-session"
    const specUrl =
      tracker === "linear"
        ? "https://linear.app/acme/issue/ENG-7"
        : "https://github.com/acme/widgets/issues/7"
    const baselineUrl = `${specUrl}#approved-revision`
    const mcp = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/deployed/mcp")
          return new Response(null, { status: deployedStatus })
        if (path === "/local/mcp" && request.method === "POST") {
          const body: unknown = await request.json()
          if (
            typeof body === "object" &&
            body !== null &&
            "method" in body &&
            body.method === "initialize"
          ) {
            return Response.json({
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2025-03-26" },
            })
          }
        }
        return new Response(null, { status: 404 })
      },
    })
    const database = makeFileDatabaseTest(join(root, "db.sqlite"))
    const withoutChecklist = {
      title: "MCP delivery",
      body: "Local and deployed MCP must both accept initialize.",
      source: { kind: "publication-comment", url: baselineUrl },
      designRevisions: [revision],
    } as const
    const checklist = approvedChecklist(baselineUrl)
    const approved: SpecBaselineResult = {
      kind: "baseline",
      baseline: { ...withoutChecklist, requirementChecklist: checklist },
    }
    const otherBaseline = `${specUrl}#local-only-revision`
    const narrowed = {
      ...withoutChecklist,
      body: "Only local MCP must accept initialize.",
      source: { kind: "publication-comment", url: otherBaseline },
    } as const
    const conflict: SpecBaselineResult = {
      kind: "review",
      candidates: [approved.baseline, narrowed],
      unreadableSnapshots: [],
    }
    let latestBaseline: SpecBaselineResult =
      decision === "baseline"
        ? conflict
        : waitForChecklist
          ? {
              kind: "baseline",
              baseline: {
                ...withoutChecklist,
                source: {
                  kind: initialSource,
                  url:
                    initialSource === "marked-parent"
                      ? specUrl
                      : initialSource === "historical-approval-comment"
                        ? `${specUrl}#historical-approval`
                        : baselineUrl,
                },
              },
            }
          : approved
    const readBaseline = () => Effect.sync(() => latestBaseline)
    const observed = {
      tracker,
      nativeId: tracker === "linear" ? "linear-native-id" : "7",
      displayId: tracker === "linear" ? "ENG-7" : "7",
      url: specUrl,
      readiness: "all-descendants-closed",
      descendants: [{ nativeId: "cancelled-child", closureReason: "canceled" }],
    } as const
    const reopened = { ...observed, readiness: "waiting" } as const
    let hierarchy: readonly SpecObservation[] = [observed]
    let failRead = false
    let turns = 0
    let continuations = 0
    let operatorAnswer: string | undefined
    const parentComments = new Map<string, string>()
    let commentAttempts = 0
    const recordComment = <E>(marker: string, body: string, error: E) =>
      Effect.suspend(() => {
        commentAttempts += 1
        if (commentAttempts === 1) return Effect.fail(error)
        parentComments.set(marker, body)
        return Effect.void
      })
    const origin = join(root, "origin")
    const repositoryPath = join(root, "repository")
    let initialCommit: string
    let integratedCommit: string
    let checkout = ""
    let reopenAfterRefresh = false
    const readHierarchy = () =>
      reopenAfterRefresh &&
      git(checkout, "rev-parse", "HEAD") === integratedCommit
        ? [reopened]
        : hierarchy
    const probe = (environment: "local" | "deployed") =>
      Effect.promise(async () => {
        const url = new URL(`${environment}/mcp`, mcp.url)
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        })
        const body = await response.text()
        const status =
          response.ok && body.includes("protocolVersion")
            ? "met"
            : response.status === 404
              ? "unmet"
              : "unverified"
        return {
          requirementId: `mcp-${environment}`,
          status,
          evidence: [
            {
              kind: status === "unverified" ? "human-verification" : "delivery",
              environment,
              detail: `POST ${url} → HTTP ${response.status}${body ? ` ${body}` : ""}`,
            },
          ],
        }
      })
    const question =
      decision === "baseline"
        ? "Which exact Spec snapshot and design revisions govern validation?"
        : baselineDecision
          ? "Which approved revision governs: local only, or local and deployed?"
          : "Did you personally waive deployed MCP, or was that an agent deferral?"
    const evidence =
      decision === "baseline"
        ? "mcp-local (reported met; not yet assessed against an approved checklist)"
        : baselineDecision
          ? `The versions ${baselineUrl} and ${otherBaseline} disagree on deployed MCP.`
          : `The same tracker account posted a purported waiver and the agent's deferral at ${specUrl}#deferral.`
    const report = (payload: unknown) => ({
      sessionId,
      assistantText: `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify(payload)}`,
    })
    const agent = Layer.succeed(AgentBackend, {
      // Controlled adapter runs real HTTP probes; a model is not needed to
      // make the lifecycle, persistence, and evidence-boundary checks repeatable.
      startTurn: (turn) =>
        Effect.gen(function* () {
          turns += 1
          expect(turn.cwd).toBe(checkout)
          expect(git(turn.cwd, "rev-parse", "HEAD")).toBe(integratedCommit)
          if (integratedCommit !== initialCommit) {
            expect(
              yield* Effect.promise(() =>
                Bun.file(join(turn.cwd, "delivery.txt")).text(),
              ),
            ).toBe("merged during checklist wait\n")
          }
          expect(turn.prompt).toContain(
            "Local and deployed MCP must both accept initialize.",
          )
          expect(turn.prompt).toContain(revision)
          expect(turn.prompt).toContain(
            `integrated default-branch commit ${integratedCommit}.`,
          )
          expect(turn.prompt).toContain("cancelled-child")
          expect(turn.prompt).toContain(checklist.sourceUrl)
          if (baselineDecision) expect(turn.prompt).toContain(narrowed.body)
          yield* turn.onSessionId?.(sessionId) ?? Effect.void
          if (decision === "baseline") {
            // Both versions require local MCP. That observation remains useful
            // even though the selected snapshot lacks an approved checklist.
            return report({
              kind: "baseline_selected",
              baselineUrl: otherBaseline,
              basis: "same_verdict",
              findings: [yield* probe("local")],
            })
          }
          if (decision !== undefined) {
            return report({
              kind: "decision_needed",
              question,
              evidence: [evidence],
              findings:
                decision === "authorship" ? [yield* probe("local")] : [],
            })
          }
          const findings = yield* Effect.all(
            omit ? [probe("local")] : [probe("local"), probe("deployed")],
          )
          return report(findings)
        }),
      continueTurn:
        decision === undefined
          ? no
          : (turn) =>
              Effect.gen(function* () {
                continuations += 1
                expect(turn.sessionId).toBe(sessionId)
                expect(turn.replyToPromptOnly).toBe(true)
                expect(turn.cwd).toBe(checkout)
                expect(git(turn.cwd, "rev-parse", "HEAD")).toBe(
                  integratedCommit,
                )
                expect(turn.prompt).toContain(question)
                expect(turn.prompt).toContain(evidence)
                if (decision === "authorship") {
                  expect(turn.prompt).toContain(
                    "MET — local MCP accepts initialize",
                  )
                }
                expect(operatorAnswer).toBe(
                  "Keep the approved local and deployed requirements.",
                )
                const findings = yield* Effect.all([
                  probe("local"),
                  probe("deployed"),
                ])
                return report(
                  baselineDecision
                    ? {
                        kind: "baseline_selected",
                        baselineUrl,
                        basis: "operator_answer",
                        findings,
                      }
                    : findings,
                )
              }),
      inspect: no,
    })
    const layers = () =>
      WorkItemLifecycleLive.pipe(
        Layer.provideMerge(stubActiveAgentBackendLayer()),
        Layer.provideMerge(
          Layer.effect(
            LifecycleSteps,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const db = yield* DbService
              const backend = yield* AgentBackend
              const github = yield* GitHubService
              const linear = yield* LinearService
              return LifecycleSteps.of({
                createWorktree: (context) => {
                  expect(context.origin).toBe("spec_validation")
                  expect(context.issueSource).toBeUndefined()
                  expect(context.sessionId).toBeNull()
                  return createWorktree(context, { tmpDir: root }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.provide(BunServices.layer),
                    Effect.tap((result) =>
                      Effect.sync(() => {
                        expect(result.startingCommitOid).toBe(initialCommit)
                        checkout = result.worktreePath
                      }),
                    ),
                  )
                },
                validateSpec: (context, input) =>
                  validateSpec(context, input).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                    Effect.provideService(DbService, db),
                    Effect.provideService(AgentBackend, backend),
                    Effect.provideService(GitHubService, github),
                    Effect.provideService(LinearService, linear),
                    Effect.provide(BunServices.layer),
                  ),
                installDependencies: no,
                implement: no,
                assessChanges: no,
                preCommit: no,
                review: no,
                commit: no,
                createPr: no,
                watchPrStatusChecks: no,
                resolvePrMergeConflict: no,
                investigatePrStatusChecks: no,
                markPrReadyForReview: no,
                decidePrMerge: no,
                mergePr: no,
                closeIssue: no,
                localCleanup: no,
                removeWorktree: no,
              })
            }),
          ),
        ),
        Layer.provideMerge(
          stubGitHubServiceLayer({
            readSpecBaseline: tracker === "github" ? readBaseline : no,
            observeSpecs:
              tracker === "github" ? () => Effect.sync(() => hierarchy) : no,
            createDraftPullRequest: no,
            ensureIssueCompletedWithSummary: no,
            ensureIssueComment:
              tracker === "github" && decision !== undefined
                ? (_repository, issueNumber, marker, body) => {
                    expect(issueNumber).toBe(7)
                    return recordComment(
                      marker,
                      body,
                      new GitHubRequestError({
                        message: "Temporary tracker outage",
                      }),
                    )
                  }
                : no,
          }),
        ),
        Layer.provideMerge(stubGitLabServiceLayer()),
        Layer.provideMerge(stubAzureDevOpsServiceLayer()),
        Layer.provideMerge(
          Layer.succeed(LinearService, {
            ...defaultLinearServiceShape,
            readSpecBaseline: tracker === "linear" ? readBaseline : no,
            observeSpecs:
              tracker === "linear"
                ? (projectId) =>
                    Effect.suspend(() => {
                      expect(projectId).toBe("validation-project")
                      return failRead
                        ? Effect.fail(
                            new LinearRequestError({
                              message: "Hierarchy read failed",
                            }),
                          )
                        : Effect.succeed(readHierarchy())
                    })
                : no,
            updateIssueState: no,
            ensureMilestoneComment:
              tracker === "linear" && decision !== undefined
                ? (nativeId, marker, body) => {
                    expect(nativeId).toBe(observed.nativeId)
                    return recordComment(
                      marker,
                      body,
                      new LinearRequestError({
                        message: "Temporary tracker outage",
                      }),
                    )
                  }
                : no,
          }),
        ),
        Layer.provideMerge(agent),
        Layer.provideMerge(DbServiceLive),
        Layer.provideMerge(SqliteQueueServiceLive),
        Layer.provideMerge(database),
      )
    try {
      await mkdir(origin)
      git(origin, "init", "-b", "main")
      git(origin, "commit", "--no-verify", "--allow-empty", "-m", "initial")
      initialCommit = git(origin, "rev-parse", "HEAD")
      integratedCommit = initialCommit
      git(root, "clone", origin, repositoryPath)
      const saved = await Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* DbService
          const lifecycle = yield* WorkItemLifecycle
          const config = yield* db.getConfig
          yield* db.updateConfig({
            ...config,
            defaultModel: "opencode/test",
            reviewModel: "opencode/test",
          })
          const pausedRepository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: repositoryPath,
            isBare: false,
          })
          const repository =
            tracker === "linear"
              ? yield* db.updateRepositorySettings({
                  ...pausedRepository,
                  repositoryId: pausedRepository.id,
                  paused: false,
                  issueTracker: "linear",
                  linearProjectId: "validation-project",
                  linearWorkflowStatuses: [
                    {
                      teamId: "team",
                      inProgressStateId: "started",
                      doneStateId: "done",
                    },
                  ],
                })
              : yield* db.unpauseRepository(pausedRepository.id)
          const list = lifecycle.listWorkItemsForRepository(repository.id)
          // The tracker produces "waiting" both for empty and open hierarchies.
          yield* lifecycle.considerSpecValidation(repository, {
            ...observed,
            readiness: "waiting",
          })
          yield* lifecycle.considerSpecValidation(repository, {
            ...observed,
            readiness: "hierarchy-unavailable",
          })
          expect(yield* list).toEqual([])
          yield* Effect.all(
            [
              lifecycle.considerSpecValidation(repository, observed),
              lifecycle.considerSpecValidation(repository, observed),
            ],
            { concurrency: "unbounded" },
          )
          const items = yield* list
          expect(items).toHaveLength(1)
          const item = items[0]!
          expect(item.origin).toBe("spec_validation")
          expect(item.issueTitle).toContain("MCP delivery")
          expect(item).not.toHaveProperty("issueSource")
          expect(item.stepRuns.map(({ step }) => step)).toEqual([
            "create_worktree",
          ])
          return { repository, id: item.id }
        }).pipe(Effect.provide(layers())),
      )

      // A new lifecycle/DB connection sees the original frozen baseline, not
      // a more recent tracker response or an implementation session.
      latestBaseline = { kind: "not-spec" }
      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          yield* lifecycle.considerSpecValidation(saved.repository, observed)
          yield* runNext(saved.id, "create_worktree")
          expect(
            yield* lifecycle.stopForCompetingIssueClosingPullRequests(
              saved.repository.id,
              [
                {
                  issueNumber: 7,
                  identities: [{ repository: "acme/widgets", number: 18 }],
                },
              ],
            ),
          ).toBe(0)
          // No new poll has reported this change yet. Use the live tracker at
          // execution time, not the observation that originally queued the job.
          failRead = tracker === "linear" && deployedStatus === 403
          hierarchy = [
            deployedStatus === 404
              ? reopened
              : { ...observed, readiness: "hierarchy-unavailable" },
          ]
          yield* runNext(saved.id, "validate_spec")
          const parked = yield* lifecycle.getWorkItem(saved.id)
          expect(parked).toMatchObject({
            state: "validate_spec",
            sessionId: null,
            holdsWorkerSlot: false,
            completionSummary: null,
          })
          expect(parked.stepRuns.at(-1)?.reasonCode).toBe(
            "waiting_for_spec_hierarchy",
          )
          expect(turns).toBe(0)
          yield* lifecycle.considerSpecValidation(saved.repository, reopened)
          expect(yield* lifecycle.admitWaitingWorkItems).toBe(0)
          expect(
            (yield* lifecycle.getWorkItem(saved.id)).stepRuns,
          ).toHaveLength(2)
        }).pipe(Effect.provide(layers())),
      )

      // Only the persisted wait reason is available after restart.
      failRead = false
      hierarchy = [observed]
      if (waitForChecklist) {
        await Effect.runPromise(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            yield* lifecycle.considerSpecValidation(saved.repository, observed)
            yield* runNext(saved.id, "validate_spec")
            const parked = yield* lifecycle.getWorkItem(saved.id)
            expect(parked).toMatchObject({
              state: "validate_spec",
              holdsWorkerSlot: false,
              sessionId: null,
              completionSummary: null,
            })
            expect(parked.stepRuns.at(-1)?.reasonCode).toBe(
              "waiting_for_approved_spec_checklist",
            )
            yield* lifecycle.considerSpecValidation(saved.repository, observed)
            expect(
              (yield* lifecycle.getWorkItem(saved.id)).stepRuns,
            ).toHaveLength(3)
            if (initialSource === "publication-comment") {
              const differentRevision = `${specUrl}#different-baseline`
              latestBaseline = {
                kind: "baseline",
                baseline: {
                  ...withoutChecklist,
                  source: {
                    kind: "publication-comment",
                    url: differentRevision,
                  },
                  requirementChecklist: approvedChecklist(differentRevision),
                },
              }
              yield* lifecycle.considerSpecValidation(
                saved.repository,
                observed,
              )
              expect(
                (yield* lifecycle.getWorkItem(saved.id)).stepRuns,
              ).toHaveLength(3)
            } else {
              // Editing the live draft is not a competing approved snapshot.
              latestBaseline = {
                kind: "baseline",
                baseline: {
                  ...narrowed,
                  source: { kind: "marked-parent", url: specUrl },
                },
              }
              yield* lifecycle.considerSpecValidation(
                saved.repository,
                observed,
              )
              expect(
                (yield* lifecycle.getWorkItem(saved.id)).stepRuns,
              ).toHaveLength(3)
            }
            expect(turns).toBe(0)
          }).pipe(Effect.provide(layers())),
        )
        if (omit && initialSource === "publication-comment") {
          await Bun.write(
            join(origin, "delivery.txt"),
            "merged during checklist wait\n",
          )
          git(origin, "add", "delivery.txt")
          git(
            origin,
            "commit",
            "--no-verify",
            "-m",
            "Integrate delivery while waiting",
          )
          integratedCommit = git(origin, "rev-parse", "HEAD")
          expect(git(checkout, "rev-parse", "HEAD")).toBe(initialCommit)
        }
        latestBaseline = approved
      }
      if (integratedCommit !== initialCommit) {
        reopenAfterRefresh = true
        await Effect.runPromise(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            yield* lifecycle.considerSpecValidation(saved.repository, observed)
            yield* runNext(saved.id, "validate_spec")
            const parked = yield* lifecycle.getWorkItem(saved.id)
            expect(parked.stepRuns.at(-1)?.reasonCode).toBe(
              "waiting_for_spec_hierarchy",
            )
            expect(parked.sessionId).toBeNull()
            expect(turns).toBe(0)
          }).pipe(Effect.provide(layers())),
        )
        reopenAfterRefresh = false
      }
      if (decision !== undefined) {
        latestBaseline =
          decision === "changed-baseline"
            ? {
                kind: "baseline",
                baseline: {
                  ...narrowed,
                  requirementChecklist: {
                    ...approvedChecklist(otherBaseline),
                    requirements: [checklist.requirements[0]],
                  },
                },
              }
            : baselineDecision
              ? conflict
              : approved
        await Effect.runPromise(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            yield* lifecycle.considerSpecValidation(saved.repository, observed)
            yield* runNext(saved.id, "validate_spec")
            const parked = yield* lifecycle.getWorkItem(saved.id)
            expect(parked).toMatchObject({
              state: "needs_human",
              failureCode: "decision_needed",
              sessionId,
              holdsWorkerSlot: false,
            })
            expect(parked.failureMessage).toContain(question)
            expect(parked.failureMessage).toContain(evidence)
            expect(parked.stepRuns.at(-1)).toMatchObject({
              step: "validate_spec",
              status: "succeeded",
              reasonCode: "decision_needed",
            })
            if (decision === "authorship") {
              expect(parked.completionSummary).toContain(
                "MET — local MCP accepts initialize",
              )
              expect(parked.completionSummary).toContain(
                "UNVERIFIED — deployed MCP accepts initialize",
              )
            } else if (decision === "baseline") {
              expect(parked.failureMessage).toContain("HTTP 200")
              expect(parked.completionSummary).toBeNull()
            }
            expect(commentAttempts).toBe(1)
            expect(parentComments.size).toBe(0)
            expect(
              (yield* lifecycle.getWorkItem(saved.id)).stepRuns,
            ).toHaveLength(waitForChecklist ? 4 : 3)
          }).pipe(Effect.provide(layers())),
        )
        // The answer is entered in the existing agent session, independent of
        // the Harness DB connection. Polling or answering is not Resume.
        operatorAnswer = "Keep the approved local and deployed requirements."
        hierarchy = [reopened]
        await Effect.runPromise(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            expect((yield* lifecycle.getWorkItem(saved.id)).state).toBe(
              "needs_human",
            )
            const resumed = yield* lifecycle.resume(saved.id)
            expect(resumed.state).toBe("validate_spec")
            yield* runNext(saved.id, "validate_spec")
            const held = yield* lifecycle.resume(saved.id)
            expect(held).toMatchObject({
              state: "validate_spec",
              sessionId,
              holdsWorkerSlot: false,
            })
            expect(held.stepRuns.at(-1)?.reasonCode).toBe(
              "waiting_for_spec_hierarchy",
            )
            expect(held.stepRuns).toHaveLength(waitForChecklist ? 5 : 4)
            expect(parentComments.size).toBe(0)
            expect(continuations).toBe(0)
          }).pipe(Effect.provide(layers())),
        )
        await Effect.runPromise(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            yield* lifecycle.considerSpecValidation(saved.repository, reopened)
            expect([...parentComments.values()]).toEqual([
              expect.stringContaining(question),
            ])
            if (decision === "baseline") {
              expect([...parentComments.values()][0]).toContain(evidence)
              expect([...parentComments.values()][0]).toContain("HTTP 200")
            }
            if (decision === "authorship") {
              expect([...parentComments.values()][0]).toContain(
                "MET — local MCP accepts initialize",
              )
            }
            const held = yield* lifecycle.getWorkItem(saved.id)
            expect(held.state).toBe("validate_spec")
            expect(held.stepRuns).toHaveLength(waitForChecklist ? 5 : 4)
            expect(continuations).toBe(0)
          }).pipe(Effect.provide(layers())),
        )
        await Effect.runPromise(
          Effect.gen(function* () {
            const lifecycle = yield* WorkItemLifecycle
            yield* lifecycle.considerSpecValidation(saved.repository, reopened)
            expect(commentAttempts).toBe(2)
            expect(parentComments.size).toBe(1)
          }).pipe(Effect.provide(layers())),
        )
        await Bun.write(
          join(origin, "follow-up.txt"),
          "integrated while waiting\n",
        )
        git(origin, "add", "follow-up.txt")
        git(origin, "commit", "--no-verify", "-m", "Close reopened descendant")
        integratedCommit = git(origin, "rev-parse", "HEAD")
        if (decision === "changed-baseline") latestBaseline = approved
        if (decision === "baseline") {
          // The current parent no longer cites the original approved
          // snapshot. The operator still chooses that saved snapshot.
          latestBaseline = { kind: "baseline", baseline: narrowed }
        }
        hierarchy = [observed]
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          yield* Effect.all(
            [
              lifecycle.considerSpecValidation(saved.repository, observed),
              lifecycle.considerSpecValidation(saved.repository, observed),
            ],
            { concurrency: "unbounded" },
          )
          if (decision === undefined) latestBaseline = { kind: "not-spec" }
          yield* runNext(saved.id, "validate_spec")
          yield* lifecycle.considerSpecValidation(saved.repository, observed)
          const items = yield* lifecycle.listWorkItemsForRepository(
            saved.repository.id,
          )
          expect(items).toHaveLength(1)
          const item = items[0]!
          expect(item).toMatchObject({
            id: saved.id,
            state: "complete",
            sessionId,
            startingCommitOid: integratedCommit,
            holdsWorkerSlot: false,
            pullRequestNumber: null,
          })
          expect(item.stepRuns.map(({ step }) => step)).toEqual([
            "create_worktree",
            "validate_spec",
            "validate_spec",
            ...(waitForChecklist ? ["validate_spec"] : []),
            ...(decision === undefined && integratedCommit !== initialCommit
              ? ["validate_spec"]
              : []),
            ...(decision !== undefined
              ? ["validate_spec", "validate_spec"]
              : []),
          ])
          expect(turns).toBe(1)
          expect(continuations).toBe(decision === undefined ? 0 : 1)
          expect(git(repositoryPath, "rev-parse", "HEAD")).toBe(initialCommit)
          expect(item.completionSummary).toContain(baselineUrl)
          expect(item.completionSummary).toContain(
            `Integrated checkout: \`${integratedCommit}\``,
          )
          expect(item.completionSummary).toContain(checklist.sourceUrl)
          expect(item.completionSummary).toContain(
            "MET — local MCP accepts initialize",
          )
          expect(item.completionSummary).toContain(
            `${expected} — deployed MCP accepts initialize`,
          )
          if (deployedStatus === 403) {
            expect(item.completionSummary).toContain(
              "human-verification (deployed)",
            )
            expect(parentComments.size).toBe(0)
          }
          expect(item.completionSummary).toContain(
            omit
              ? "The validator omitted this approved requirement"
              : `HTTP ${deployedStatus}`,
          )
          const [row] = yield* sql.unsafe<{ spec_validation_findings: string }>(
            "SELECT spec_validation_findings FROM work_item WHERE id = ?",
            [saved.id],
          )
          expect(
            JSON.parse(row!.spec_validation_findings).map(
              (finding: { status: string }) => finding.status,
            ),
          ).toEqual(["met", expected.toLowerCase()])
        }).pipe(Effect.provide(layers())),
      )
    } finally {
      await mcp.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

it("requires applicable delivery evidence for a positive deployed verdict", async () => {
  const kinds = [
    "closure",
    "disclaimer",
    "unshipped-experiment",
    "human-verification",
    "delivery",
  ]
  for (const kind of kinds) {
    const findings = await Effect.runPromise(
      decodeSpecFindings(
        `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify([
          {
            requirementId: "mcp-deployed",
            status: "met",
            evidence: [
              {
                kind,
                environment: kind === "delivery" ? "local" : "deployed",
                detail: "Not deployed evidence",
              },
            ],
          },
        ])}`,
        approvedChecklist("https://example.com/baseline"),
      ),
    )
    expect(findings.find(({ id }) => id === "mcp-deployed")?.status).toBe(
      "unverified",
    )
  }
})

it("records only approved IDs and treats duplicate or missing evidence as unverified", async () => {
  const checklist = approvedChecklist("https://example.com/baseline")
  const entry = {
    requirementId: "mcp-local",
    status: "met",
    evidence: [
      {
        kind: "delivery",
        environment: "local",
        detail: "Local handshake passed",
      },
    ],
  }
  const findings = await Effect.runPromise(
    decodeSpecFindings(
      `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify([entry, entry, { ...entry, requirementId: "invented" }])}`,
      checklist,
    ),
  )
  expect(findings.map(({ id, status }) => [id, status])).toEqual([
    ["mcp-local", "unverified"],
    ["mcp-deployed", "unverified"],
  ])
  expect(findings[0]?.evidence[0]?.detail).toContain("more than once")
  expect(findings[1]?.evidence[0]?.detail).toContain("omitted")
  expect(
    await Effect.runPromise(
      decodeSpecFindings("READY_FOR_AGENT_SPEC_FINDINGS:\n[]", checklist),
    ),
  ).toHaveLength(2)
})
