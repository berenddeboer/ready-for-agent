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
  SpecBaselineResult,
  SpecFollowUpPublication,
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
import { specCloseOutTracker } from "../src/lib/spec-close-out-tracker-test.js"
import { decodeSpecFindings, validateSpec } from "../src/lib/validate-spec.js"
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
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
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
  },
  {
    tracker: "linear",
    deployedStatus: 403,
    expected: "UNVERIFIED",
    humanCheck: true,
    updateSpecWhileWaiting: true,
  },
  {
    tracker: "github",
    deployedStatus: 404,
    expected: "UNMET",
  },
  {
    tracker: "github",
    deployedStatus: 403,
    expected: "UNVERIFIED",
  },
  {
    tracker: "github",
    deployedStatus: 403,
    expected: "UNVERIFIED",
    humanCheck: true,
  },
  {
    tracker: "linear",
    deployedStatus: 404,
    expected: "UNMET",
    decision: "authorship",
  },
  ...(["github", "linear"] as const).flatMap((tracker) =>
    (
      [
        "stale",
        "retry",
        "retry-after-reopen",
        "closed-before-publication",
        "canceled-after-publication",
        "manual-reopen",
        "abandon-then-reopen",
      ] as const
    ).map(
      (closeOut) =>
        ({
          tracker,
          deployedStatus:
            closeOut === "manual-reopen" || closeOut === "abandon-then-reopen"
              ? 404
              : 200,
          expected:
            closeOut === "manual-reopen" || closeOut === "abandon-then-reopen"
              ? "UNMET"
              : "MET",
          closeOut,
        }) as const,
    ),
  ),
] as const)(
  "$tracker: records $expected for deployed HTTP $deployedStatus (decision: $decision, close-out: $closeOut)",
  async (scenario) => {
    const { tracker, deployedStatus, expected } = scenario
    const closeOut = "closeOut" in scenario ? scenario.closeOut : undefined
    const decision = "decision" in scenario ? scenario.decision : undefined
    const humanCheck = "humanCheck" in scenario
    const updateSpecWhileWaiting = "updateSpecWhileWaiting" in scenario
    const retryPublication =
      closeOut === undefined && decision === undefined && deployedStatus === 404
    const mixedEvidence = tracker === "github" && retryPublication
    const deployedVerdict = mixedEvidence ? "UNVERIFIED" : expected
    const expectChild =
      retryPublication ||
      humanCheck ||
      decision !== undefined ||
      (closeOut !== undefined && deployedStatus === 404)
    const inconsistentVerdict = deployedStatus === 403 && !humanCheck
    const root = await mkdtemp(join(tmpdir(), "spec-validation-"))
    const sessionId = "spec-validator-own-session"
    const specUrl =
      tracker === "linear"
        ? "https://linear.app/acme/issue/ENG-7"
        : "https://github.com/acme/widgets/issues/7"
    const mcp = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/deployed/mcp" && deployedStatus !== 200)
          return new Response(null, { status: deployedStatus })
        if (path === "/deployed/gateway")
          return new Response(null, { status: 200 })
        if (path === "/deployed/region/mcp" && mixedEvidence)
          return new Response(null, { status: 403 })
        if (
          (path === "/local/mcp" || path === "/deployed/mcp") &&
          request.method === "POST"
        ) {
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
    const initialBody = `Local and deployed MCP must both accept initialize.${retryPublication ? " The deployed promise includes the public and regional routes. The deployed health and readiness endpoints must report ready." : ""}`
    const updatedBody = `${initialBody} Include the updated production note.`
    const currentSpecDoc = {
      title: "MCP delivery",
      body: initialBody,
      url: specUrl,
    } as const
    const incompleteRequirement = {
      id: "deployment-health",
      environment: "deployed",
      requirement: "deployed health and readiness endpoints report ready",
    } as const
    let latestSpec: SpecBaselineResult = {
      kind: "baseline",
      baseline: currentSpecDoc,
    }
    const readBaseline = () => Effect.sync(() => latestSpec)
    const native =
      closeOut === undefined
        ? undefined
        : specCloseOutTracker(specUrl, {
            title: currentSpecDoc.title,
            description: currentSpecDoc.body,
          })
    const reconcile = (
      repository: Parameters<
        (typeof WorkItemLifecycle.Service)["considerSpecValidation"]
      >[0],
    ) =>
      Effect.gen(function* () {
        if (!native) throw new Error("Expected a tracker at the HTTP boundary")
        const lifecycle = yield* WorkItemLifecycle
        const observations =
          tracker === "linear"
            ? yield* native.linear.observeSpecs("validation-project")
            : yield* native.github.observeSpecs({
                forge: "github",
                forgeHost: "github.com",
                projectPath: "acme/widgets",
              })
        for (const observation of observations) {
          yield* lifecycle.considerSpecValidation(repository, {
            ...observation,
            tracker,
          })
        }
      })
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
    let draftingTurns = 0
    const followUpUrl = `${specUrl}/follow-up`
    const gapUrl = (gapId: string) => `${followUpUrl}/${gapId}`
    const children = new Map<
      string,
      SpecFollowUpPublication["children"][number]
    >()
    let parentFindings: string | undefined
    const publishTest = (publication: SpecFollowUpPublication) =>
      Effect.sync(() => {
        expect(expectChild).toBeTrue()
        expect(publication.parentId).toBe(observed.nativeId)
        const partialWrite = retryPublication && children.size === 0
        for (const child of partialWrite
          ? publication.children.slice(0, 1)
          : publication.children)
          children.set(child.gapId, child)
        hierarchy = [reopened]
        if (partialWrite) return false
        parentFindings = `${publication.findings}\n${publication.children.map(({ gapId }) => gapUrl(gapId)).join("\n")}`
        return true
      })
    const followUpResult = (publication: SpecFollowUpPublication) =>
      publication.children.map(({ requirementId, gapId }) => ({
        requirementId,
        gapId,
        url: gapUrl(gapId),
      }))
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
          requirement: `${environment} MCP accepts initialize`,
          environment,
          status,
          evidence: [
            {
              kind:
                status === "unmet"
                  ? "defect"
                  : status === "unverified"
                    ? "unavailable"
                    : "delivery",
              ...(status === "unmet" ? { gapId: "public-route" } : {}),
              environment,
              detail: `POST ${url} → HTTP ${response.status}${body ? ` ${body}` : ""}`,
            },
          ],
          ...(status === "unmet"
            ? {
                followUps: [
                  {
                    gapId: "public-route",
                    kind: "fix",
                    owner: "agent",
                    title: "Deliver deployed MCP",
                    task: "Expose the deployed /mcp route",
                    acceptanceCheck:
                      "POST initialize to deployed /mcp and receive a protocolVersion.",
                  },
                ],
              }
            : {}),
        }
      })
    const question =
      "Did you personally waive deployed MCP, or was that an agent deferral?"
    const evidence = `The same tracker account posted a purported waiver and the agent's deferral at ${specUrl}#deferral.`
    const report = (payload: unknown) => ({
      sessionId,
      assistantText: `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify(payload)}`,
    })
    let afterValidation = () => {}
    const validator = {
      // Controlled adapter runs real HTTP probes; a model is not needed to
      // make the lifecycle, persistence, and evidence-boundary checks repeatable.
      startTurn: (turn: Parameters<typeof AgentBackend.Service.startTurn>[0]) =>
        Effect.gen(function* () {
          turns += 1
          expect(turn.cwd).toBe(checkout)
          expect(git(turn.cwd, "rev-parse", "HEAD")).toBe(integratedCommit)
          if (integratedCommit !== initialCommit) {
            expect(
              yield* Effect.promise(() =>
                Bun.file(join(turn.cwd, "delivery.txt")).text(),
              ),
            ).toBe("merged during hierarchy wait\n")
          }
          expect(turn.prompt).toContain(
            updateSpecWhileWaiting ? updatedBody : initialBody,
          )
          expect(turn.prompt).toContain(
            `integrated default-branch commit ${integratedCommit}.`,
          )
          expect(turn.prompt).toContain("cancelled-child")
          yield* turn.onSessionId?.(sessionId) ?? Effect.void
          if (decision !== undefined) {
            return report({
              kind: "decision_needed",
              question,
              evidence: [evidence],
              findings: [yield* probe("local"), yield* probe("deployed")],
            })
          }
          const probeFollowUps = (environment: "local" | "deployed") =>
            Effect.promise(async () => {
              const url = new URL(`${environment}/mcp`, mcp.url)
              const response = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                }),
              })
              const body = await response.text()
              const gateway =
                inconsistentVerdict && environment === "deployed"
                  ? await fetch(new URL("deployed/gateway", mcp.url))
                  : undefined
              const regionalUrl = new URL("deployed/region/mcp", mcp.url)
              const regional =
                environment === "deployed" && retryPublication
                  ? await fetch(regionalUrl, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "initialize",
                      }),
                    })
                  : undefined
              const status =
                response.ok && body.includes("protocolVersion")
                  ? "met"
                  : response.status === 404
                    ? "unmet"
                    : "unverified"
              return {
                requirementId: `mcp-${environment}`,
                requirement: `${environment} MCP accepts initialize`,
                environment,
                status:
                  inconsistentVerdict && environment === "deployed"
                    ? "unmet"
                    : regional?.status === 403
                      ? "unverified"
                      : status,
                evidence: [
                  ...(gateway !== undefined
                    ? [
                        {
                          kind: "delivery",
                          environment,
                          detail: `GET ${gateway.url} → HTTP ${gateway.status}`,
                          gapId: "gateway",
                        },
                      ]
                    : []),
                  {
                    kind:
                      status === "unmet"
                        ? "defect"
                        : status === "unverified"
                          ? humanCheck
                            ? "human-access"
                            : "unavailable"
                          : "delivery",
                    ...(status === "unmet" ||
                    (status === "unverified" && tracker === "github")
                      ? { gapId: "public-route" }
                      : {}),
                    environment,
                    detail: `POST ${url} → HTTP ${response.status}${body ? ` ${body}` : ""}`,
                  },
                  ...(regional === undefined
                    ? []
                    : [
                        {
                          kind:
                            regional.status === 403 ? "human-access" : "defect",
                          gapId: "regional-route",
                          environment,
                          detail: `POST ${regionalUrl} → HTTP ${regional.status}`,
                        },
                      ]),
                ],
                ...(status === "unmet"
                  ? {
                      followUps: [
                        {
                          gapId: "public-route",
                          kind: "fix",
                          owner: "agent",
                          title: "Deliver deployed MCP",
                          task: "Expose the deployed /mcp route",
                          acceptanceCheck:
                            "POST initialize to deployed /mcp and receive a protocolVersion.",
                        },
                        {
                          gapId: "regional-route",
                          ...(mixedEvidence
                            ? { kind: "human-verification" }
                            : { kind: "fix", owner: "human" }),
                          title: "Deliver regional deployed MCP",
                          task: mixedEvidence
                            ? "Have the operator check /region/mcp with production access."
                            : "Have the operator expose /region/mcp through the human-managed regional gateway.",
                          acceptanceCheck:
                            "POST initialize to deployed /region/mcp and receive a protocolVersion.",
                        },
                      ],
                    }
                  : status === "unverified"
                    ? {
                        followUps: [
                          {
                            gapId: "public-route",
                            kind: "human-verification",
                            title: "Verify deployed MCP",
                            task: humanCheck
                              ? "Have the deployment operator run initialize using their production access."
                              : "Try the same request again after the transient failure.",
                            acceptanceCheck:
                              "POST initialize to deployed /mcp and receive a protocolVersion.",
                          },
                          ...(inconsistentVerdict
                            ? [
                                {
                                  gapId: "gateway",
                                  kind: "fix",
                                  owner: "agent",
                                  title: "Replace the deployed gateway",
                                  task: "Replace the gateway.",
                                  acceptanceCheck:
                                    "The gateway responds HTTP 200.",
                                },
                              ]
                            : []),
                        ],
                      }
                    : {}),
              }
            })
          const findings = yield* Effect.all([
            probeFollowUps("local"),
            probeFollowUps("deployed"),
          ])
          const incomplete = retryPublication
            ? yield* Effect.promise(async () => {
                const evidence = await Promise.all(
                  ["health", "readiness"].map(async (route) => {
                    const url = new URL(`deployed/${route}`, mcp.url)
                    const response = await fetch(url)
                    return {
                      kind: "defect",
                      ...(route === "health"
                        ? {}
                        : { gapId: "not a valid id" }),
                      environment: "deployed",
                      detail: `GET ${url} → HTTP ${response.status}`,
                    }
                  }),
                )
                return [
                  {
                    requirementId: incompleteRequirement.id,
                    requirement: incompleteRequirement.requirement,
                    environment: incompleteRequirement.environment,
                    status: "unmet",
                    evidence,
                    ...(tracker === "github"
                      ? {
                          followUps: [
                            { gapId: "health", kind: "fix", owner: "agent" },
                          ],
                        }
                      : {}),
                  },
                ]
              })
            : []
          afterValidation()
          return report([...findings, ...incomplete])
        }),
      continueTurn: (
        turn: Parameters<typeof AgentBackend.Service.continueTurn>[0],
      ) =>
        turn.prompt.includes("<saved_gap_evidence>")
          ? Effect.sync(() => {
              expect(retryPublication).toBeTrue()
              expect(turn.sessionId).toBe(sessionId)
              expect(turn.prompt).toContain("Do not repeat validation")
              expect(turn.prompt).not.toContain("public-route")
              draftingTurns += 1
              const first = draftingTurns === 1
              const route = first ? "health" : "readiness"
              expect(turn.prompt).toContain(`deployed/${route}`)
              if (!first) expect(turn.prompt).not.toContain("deployed/health")
              return {
                sessionId,
                assistantText: JSON.stringify([
                  {
                    requirementId: incompleteRequirement.id,
                    followUps: [
                      {
                        gapId: first ? "recovered-gap-1" : "recovered-gap-2",
                        kind: "fix",
                        owner: "agent",
                        title: `Expose deployed ${route} endpoint`,
                        task: `Serve readiness on the deployed ${route} route.`,
                        acceptanceCheck: `GET /${route} on the deployment returns HTTP 200 and the ready status.`,
                      },
                    ],
                  },
                  ...(first ? [{ followUps: [] }] : []),
                ]),
              }
            })
          : Effect.gen(function* () {
              expect(decision).toBeDefined()
              continuations += 1
              expect(turn.sessionId).toBe(sessionId)
              expect(turn.replyToPromptOnly).toBe(true)
              expect(turn.cwd).toBe(checkout)
              expect(git(turn.cwd, "rev-parse", "HEAD")).toBe(integratedCommit)
              expect(turn.prompt).toContain(question)
              expect(turn.prompt).toContain(evidence)
              expect(turn.prompt).toContain(
                "MET — local MCP accepts initialize",
              )
              expect(operatorAnswer).toBe(
                "Keep the approved local and deployed requirements.",
              )
              const findings = yield* Effect.all([
                probe("local"),
                probe("deployed"),
              ])
              return report(findings)
            }),
      inspect: no,
    }
    const agent = Layer.succeed(AgentBackend, {
      ...validator,
      continueTurn:
        closeOut === undefined ? validator.continueTurn : validator.startTurn,
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
            ...(tracker === "github" ? native?.github : {}),
            publishSpecFollowUps:
              tracker === "github"
                ? (repository, publication) =>
                    Effect.gen(function* () {
                      expect(repository.projectPath).toBe("acme/widgets")
                      if (!(yield* publishTest(publication))) {
                        return yield* new GitHubRequestError({
                          message: "Lost response after creating a follow-up",
                        })
                      }
                      return followUpResult(publication)
                    })
                : no,
            readSpecBaseline:
              tracker === "github"
                ? (native?.github.readSpecBaseline ?? readBaseline)
                : no,
            observeSpecs:
              tracker === "github"
                ? (native?.github.observeSpecs ??
                  (() => Effect.sync(() => hierarchy)))
                : no,
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
            ...(tracker === "linear" ? native?.linear : {}),
            publishSpecFollowUps:
              tracker === "linear"
                ? (projectId, publication) =>
                    Effect.gen(function* () {
                      expect(projectId).toBe("validation-project")
                      if (!(yield* publishTest(publication))) {
                        return yield* new LinearRequestError({
                          message: "Lost response after creating a follow-up",
                        })
                      }
                      return followUpResult(publication)
                    })
                : no,
            readSpecBaseline:
              tracker === "linear"
                ? (native?.linear.readSpecBaseline ?? readBaseline)
                : no,
            observeSpecs:
              tracker === "linear"
                ? (native?.linear.observeSpecs ??
                  ((projectId) =>
                    Effect.suspend(() => {
                      expect(projectId).toBe("validation-project")
                      return failRead
                        ? Effect.fail(
                            new LinearRequestError({
                              message: "Hierarchy read failed",
                            }),
                          )
                        : Effect.succeed(readHierarchy())
                    })))
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
                      teamKey: "ENG",
                      teamName: "Engineering",
                      inProgressStateId: "started",
                      inProgressStateName: "In Progress",
                      doneStateId: "done",
                      doneStateName: "Done",
                    },
                  ],
                })
              : yield* db.unpauseRepository(pausedRepository.id)
          const list = lifecycle.listWorkItemsForRepository(repository.id)
          if (native) {
            native.tracker.closed = true
            yield* reconcile(repository)
            expect(yield* list).toEqual([])
            expect(native.tracker.comments).toEqual([])
            native.tracker.closed = false
            yield* reconcile(repository)
            yield* reconcile(repository)
            const [item, extra] = yield* list
            if (item === undefined || extra !== undefined)
              throw new Error("Expected one validation Work Item")
            return { repository, id: item.id }
          }
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

      if (native && closeOut) {
        const { tracker: fake } = native
        const boot = <A, E>(effect: Effect.Effect<A, E, WorkItemLifecycle>) =>
          Effect.runPromise(effect.pipe(Effect.provide(layers())))
        const item = Effect.flatMap(WorkItemLifecycle, (lifecycle) =>
          lifecycle.getWorkItem(saved.id),
        )
        const run = (step: string) => runNext(saved.id, step)
        const list = Effect.flatMap(WorkItemLifecycle, (lifecycle) =>
          lifecycle.listWorkItemsForRepository(saved.repository.id),
        )
        const retryClose = Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          yield* lifecycle.retry(saved.id)
          yield* run("close_issue")
        })
        if (closeOut === "stale") {
          // Even if a newly added descendant is already closed, it was not
          // part of the hierarchy that the validator assessed.
          afterValidation = () => {
            fake.childAdded = true
          }
        }
        await boot(run("create_worktree"))
        if (closeOut === "abandon-then-reopen") {
          // This reopening precedes the operator's abandonment. It must not
          // start a replacement validation on the next poll.
          fake.closed = true
          fake.reopen(
            tracker === "github"
              ? new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
              : new Date().toISOString(),
          )
          const abandon = Effect.flatMap(WorkItemLifecycle, (lifecycle) =>
            lifecycle.abandon(saved.id),
          )
          if (tracker === "github") {
            fake.historyUnavailable = true
            await expect(boot(abandon)).rejects.toThrow(
              "No abandonment was recorded",
            )
            expect((await boot(item)).state).toBe("validate_spec")
            fake.historyUnavailable = false
          }
          await boot(abandon)
        } else {
          await boot(run("validate_spec"))
        }
        if (
          closeOut === "manual-reopen" ||
          closeOut === "abandon-then-reopen"
        ) {
          const original = await boot(item)
          if (closeOut === "abandon-then-reopen") {
            expect(original.state).toBe("abandoned")
            expect(turns).toBe(0)
          } else {
            expect(original.state).toBe("complete")
            expect(original.completionSummary).toContain(
              "UNMET — deployed MCP accepts initialize",
            )
          }
          const refresh = () => boot(reconcile(saved.repository))
          await refresh()
          expect(await boot(list)).toHaveLength(1)
          fake.closedAt = "2026-11-24T02:00:00Z"
          await refresh()
          expect(await boot(list)).toHaveLength(1)
          fake.closed = true
          await refresh()
          expect(await boot(list)).toHaveLength(1)
          expect(fake.comments).toEqual([])

          // The closing and reopening can also happen between polls. Even
          // with a new native event, an open descendant still prevents work.
          fake.childOpen = true
          fake.reopen(
            new Date(
              tracker === "github" && closeOut === "abandon-then-reopen"
                ? Math.floor(original.stateReadyAt.getTime() / 1000) * 1000
                : original.stateReadyAt.getTime() + 1000,
            ).toISOString(),
          )
          await refresh()
          expect(await boot(list)).toHaveLength(1)
          fake.childOpen = false
          await refresh()
          const next = (await boot(list)).find(({ id }) => id !== saved.id)
          if (!next)
            throw new Error("Reopened parent did not admit a new validation")
          expect(next.state).toBe("create_worktree")
          await boot(runNext(next.id, "create_worktree"))
          await boot(runNext(next.id, "validate_spec"))
          await refresh()
          expect(await boot(list)).toHaveLength(2)

          fake.closed = true
          fake.reopen()
          await refresh()
          expect(await boot(list)).toHaveLength(3)
          expect(fake.closed).toBe(false)
          expect(fake.comments).toEqual([])
          return
        }
        expect(await boot(item)).toMatchObject({ state: "close_issue" })
        expect((await boot(item)).completionSummary).toContain(
          "MET — deployed MCP accepts initialize",
        )
        expect(fake.comments).toEqual([])
        expect(fake.closed).toBe(false)

        if (closeOut === "closed-before-publication") {
          fake.closed = true
          await boot(run("close_issue"))
          expect((await boot(item)).state).toBe("close_issue")
          expect((await boot(item)).stepRuns.at(-1)?.reasonCode).toBe(
            "waiting_for_spec_hierarchy",
          )
          expect(fake.comments).toEqual([])
          expect(fake.closed).toBe(true)
          await boot(reconcile(saved.repository))
          expect(await boot(list)).toHaveLength(1)
          fake.reopen()
          await boot(reconcile(saved.repository))
          await boot(run("close_issue"))
          expect((await boot(item)).stepRuns.at(-1)?.reasonMessage).toContain(
            "The parent Spec was reopened",
          )
          expect(fake.comments).toEqual([])
          expect(fake.closed).toBe(false)
          await boot(reconcile(saved.repository))
          expect(await boot(list)).toHaveLength(2)
          return
        }

        if (closeOut === "canceled-after-publication") {
          fake.afterPublication = () => {
            fake.closed = true
            fake.canceled = true
            return undefined
          }
          await boot(run("close_issue"))
          expect((await boot(item)).state).toBe("close_issue")
          expect((await boot(item)).stepRuns.at(-1)?.reasonCode).toBe(
            "waiting_for_spec_hierarchy",
          )
          expect(fake.comments).toHaveLength(1)
          expect(fake.canceled).toBe(true)
          return
        }

        if (closeOut === "stale") {
          await boot(run("close_issue"))
          expect(await boot(item)).toMatchObject({ state: "validate_spec" })
          expect(fake.comments).toEqual([])
          expect(fake.closed).toBe(false)
          await boot(run("validate_spec"))

          // GitHub reports whole seconds: a close/reopen/close in the same
          // second preserves the time and reason but changes the native event.
          if (tracker === "github") {
            fake.childReopenEventId = "child-reopened-in-the-same-second"
          } else {
            fake.closedAt = "2026-11-24T01:00:00Z"
          }
          await boot(run("close_issue"))
          expect(await boot(item)).toMatchObject({ state: "validate_spec" })
          expect(fake.comments).toEqual([])
          expect(fake.closed).toBe(false)
          await boot(run("validate_spec"))

          fake.incomplete = true
          await boot(run("close_issue"))
          expect((await boot(item)).stepRuns.at(-1)?.reasonCode).toBe(
            "waiting_for_spec_hierarchy",
          )
          expect(fake.comments).toEqual([])
          expect(fake.closed).toBe(false)
          fake.incomplete = false
          await boot(reconcile(saved.repository))

          // A reopen racing publication must prevent the subsequent closure.
          fake.afterPublication = () => {
            fake.childOpen = true
            return undefined
          }
          await boot(run("close_issue"))
          expect(await boot(item)).toMatchObject({ state: "validate_spec" })
          expect(fake.comments).toHaveLength(1)
          expect(fake.closed).toBe(false)
          await boot(run("validate_spec"))
          expect((await boot(item)).stepRuns.at(-1)?.reasonCode).toBe(
            "waiting_for_spec_hierarchy",
          )
          fake.childOpen = false
          fake.closedAt = "2026-11-24T02:00:00Z"
          fake.afterPublication = () => undefined
          await boot(reconcile(saved.repository))
          await boot(run("validate_spec"))
          await boot(run("close_issue"))
          expect(fake.comments).toHaveLength(2)
          expect(turns).toBe(4)
        } else {
          const lostResponse = () => Response.json({}, { status: 500 })
          fake.afterPublication = lostResponse
          await boot(run("close_issue"))
          expect((await boot(item)).stepRuns.at(-1)?.status).toBe("failed")
          expect(fake.closed).toBe(false)
          expect(fake.comments).toHaveLength(1)

          fake.afterPublication = () => undefined
          if (closeOut === "retry") {
            const original = fake.comments[0]
            if (!original) throw new Error("Expected a published verdict")
            const edited = original.replace(
              "Spec validation: passed",
              "Edited by a reviewer",
            )
            fake.comments[0] = edited
            await boot(retryClose)
            expect((await boot(item)).stepRuns.at(-1)).toMatchObject({
              status: "failed",
              reasonMessage: expect.stringContaining(
                "restore the evidence summary",
              ),
            })
            expect(fake.comments).toEqual([edited])
            expect(fake.closed).toBe(false)
            fake.comments[0] = original

            if (tracker === "linear") {
              fake.closeGuardUnauthorized = true
              await boot(retryClose)
              expect((await boot(item)).stepRuns.at(-1)).toMatchObject({
                status: "failed",
                reasonMessage: expect.stringContaining(
                  "API key is invalid or expired",
                ),
              })
              expect(fake.comments).toEqual([original])
              expect(fake.closed).toBe(false)
              fake.closeGuardUnauthorized = false
            }
          }
          fake.beforeClose = lostResponse
          await boot(retryClose)
          expect((await boot(item)).stepRuns.at(-1)?.status).toBe("failed")
          expect(fake.closed).toBe(false)
          expect(fake.comments).toHaveLength(1)

          fake.beforeClose = () => {
            fake.closed = true
            return lostResponse()
          }
          await boot(retryClose)
          expect((await boot(item)).stepRuns.at(-1)?.status).toBe("failed")
          expect(fake.closed).toBe(true)
          if (closeOut === "retry-after-reopen") {
            fake.reopen()
            fake.beforeClose = () => undefined
            await boot(retryClose)
            expect(fake.closed).toBe(false)
            expect(fake.comments).toHaveLength(1)
            expect((await boot(item)).stepRuns.at(-1)?.reasonMessage).toContain(
              "The parent Spec was reopened",
            )
            expect(turns).toBe(1)

            await boot(reconcile(saved.repository))
            await boot(reconcile(saved.repository))
            const items = await boot(list)
            expect(items).toHaveLength(2)
            const next = items.find(({ id }) => id !== saved.id)
            if (!next)
              throw new Error("Reopened parent did not admit a new validation")
            await boot(runNext(next.id, "create_worktree"))
            await boot(runNext(next.id, "validate_spec"))
            expect(fake.closed).toBe(false)
            await boot(runNext(next.id, "close_issue"))
            expect(turns).toBe(2)
            expect(fake.closed).toBe(true)
            expect(fake.comments).toHaveLength(2)
            return
          }
          await boot(retryClose)
          expect(fake.comments).toHaveLength(1)
          expect(turns).toBe(1)
        }
        expect(fake.closed).toBe(true)
        expect(await boot(item)).toMatchObject({ state: "complete" })
        const comment = fake.comments.at(-1)
        expect(comment).toContain("## Spec validation: passed")
        expect(comment).toContain("MET — local MCP accepts initialize")
        expect(comment).toContain("MET — deployed MCP accepts initialize")
        expect(comment).toContain(specUrl)

        fake.childOpen = true
        await boot(reconcile(saved.repository))
        expect(fake.closed).toBe(true)
        expect(await boot(list)).toHaveLength(1)
        fake.reopen()
        await boot(reconcile(saved.repository))
        expect(await boot(list)).toHaveLength(1)
        fake.childOpen = false
        await boot(reconcile(saved.repository))
        await boot(reconcile(saved.repository))
        expect(await boot(list)).toHaveLength(2)
        return
      }

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

      failRead = false
      hierarchy = [observed]
      if (updateSpecWhileWaiting) {
        // An update to the parent Spec before validation runs is read live,
        // and new commits merged while waiting are picked up before the turn.
        latestSpec = {
          kind: "baseline",
          baseline: { ...currentSpecDoc, body: updatedBody },
        }
        await Bun.write(
          join(origin, "delivery.txt"),
          "merged during hierarchy wait\n",
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
            expect(parked.completionSummary).toContain(
              "MET — local MCP accepts initialize",
            )
            expect(parked.completionSummary).toContain(
              "UNMET — deployed MCP accepts initialize",
            )
            expect(parked.completionSummary).toContain(gapUrl("public-route"))
            expect(children.size).toBe(1)
            expect(commentAttempts).toBe(1)
            expect(parentComments.size).toBe(0)
            expect(
              (yield* lifecycle.getWorkItem(saved.id)).stepRuns,
            ).toHaveLength(3)
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
            expect(held.stepRuns).toHaveLength(4)
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
            expect([...parentComments.values()][0]).toContain(
              "MET — local MCP accepts initialize",
            )
            const held = yield* lifecycle.getWorkItem(saved.id)
            expect(held.state).toBe("validate_spec")
            expect(held.stepRuns).toHaveLength(4)
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
        hierarchy = [observed]
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          yield* Effect.all(
            [
              lifecycle.considerSpecValidation(saved.repository, observed),
              lifecycle.considerSpecValidation(saved.repository, observed),
            ],
            { concurrency: "unbounded" },
          )
          yield* runNext(saved.id, "validate_spec")
          if (retryPublication) {
            expect(children.size).toBe(1)
            expect(parentFindings).toBeUndefined()
            expect(
              (yield* lifecycle.getWorkItem(saved.id)).stepRuns.at(-1)?.status,
            ).toBe("failed")
          }
        }).pipe(Effect.provide(layers())),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const lifecycle = yield* WorkItemLifecycle
          const sql = yield* SqlClient.SqlClient
          if (retryPublication) {
            // A failed draft retry must still publish valid gaps without
            // running another validation with an open child in the hierarchy.
            yield* lifecycle.considerSpecValidation(saved.repository, reopened)
            yield* lifecycle.retry(saved.id)
            yield* runNext(saved.id, "validate_spec")
            const waiting = yield* lifecycle.getWorkItem(saved.id)
            expect(waiting.state).toBe("validate_spec")
            expect(waiting.stepRuns.at(-1)).toMatchObject({
              status: "failed",
              reasonMessage: expect.stringContaining(
                "deployment-health/recovered-gap-2",
              ),
            })
            expect(children.size).toBe(3)
            expect(children.get("recovered-gap-1")?.body).toContain(
              "deployed/health",
            )
            expect(children.has("recovered-gap-2")).toBeFalse()
            expect(parentFindings).toContain(
              "Follow-up not yet specified: recovered-gap-2",
            )
            yield* lifecycle.retry(saved.id)
            yield* runNext(saved.id, "validate_spec")
          }
          yield* lifecycle.considerSpecValidation(
            saved.repository,
            expectChild ? reopened : observed,
          )
          const items = yield* lifecycle.listWorkItemsForRepository(
            saved.repository.id,
          )
          expect(items).toHaveLength(1)
          const item = items[0]!
          expect(item).toMatchObject({
            id: saved.id,
            state: decision === "authorship" ? "needs_human" : "complete",
            sessionId,
            startingCommitOid: integratedCommit,
            holdsWorkerSlot: false,
            pullRequestNumber: null,
          })
          if (decision === "authorship") {
            // The operator kept the requirement, but integration still fails
            // the same check. Do not file the already-owned gap again.
            expect(item.failureMessage).toContain("still lacks a resolution")
            expect(item.failureMessage).toContain(gapUrl("public-route"))
          }
          expect(item.stepRuns.map(({ step }) => step)).toEqual([
            "create_worktree",
            "validate_spec",
            "validate_spec",
            ...(updateSpecWhileWaiting ? ["validate_spec"] : []),
            ...(decision !== undefined
              ? ["validate_spec", "validate_spec"]
              : []),
            ...(retryPublication ? ["validate_spec", "validate_spec"] : []),
          ])
          expect(turns).toBe(1)
          expect(continuations).toBe(decision === undefined ? 0 : 1)
          expect(draftingTurns).toBe(retryPublication ? 2 : 0)
          expect(git(repositoryPath, "rev-parse", "HEAD")).toBe(initialCommit)
          expect(item.completionSummary).toContain(specUrl)
          expect(item.completionSummary).toContain(
            `Integrated checkout: \`${integratedCommit}\``,
          )
          expect(item.completionSummary).toContain(
            "MET — local MCP accepts initialize",
          )
          expect(item.completionSummary).toContain(
            `${deployedVerdict} — deployed MCP accepts initialize`,
          )
          if (deployedStatus === 403) {
            expect(item.completionSummary).toContain(
              humanCheck ? "human-access (deployed)" : "unavailable (deployed)",
            )
            expect(parentComments.size).toBe(0)
          }
          expect(item.completionSummary).toContain(`HTTP ${deployedStatus}`)
          const [row] = yield* sql.unsafe<{ spec_validation_findings: string }>(
            "SELECT spec_validation_findings FROM work_item WHERE id = ?",
            [saved.id],
          )
          expect(
            JSON.parse(row!.spec_validation_findings).map(
              (finding: { status: string }) => finding.status,
            ),
          ).toEqual([
            "met",
            deployedVerdict.toLowerCase(),
            ...(retryPublication ? ["unmet"] : []),
          ])
          expect(children.size).toBe(retryPublication ? 4 : expectChild ? 1 : 0)
          if (inconsistentVerdict) {
            expect(item.completionSummary).toContain("delivery (deployed)")
            expect(item.completionSummary).toContain("HTTP 200")
            expect(item.completionSummary).not.toContain("defect (deployed)")
            expect(item.completionSummary).toContain(
              "The validator reported unmet, but did not record a directly observed defect",
            )
          }
          if (expectChild) {
            const child = children.get("public-route")
            expect(child?.label).toBe(
              humanCheck ? "ready-for-human" : "ready-for-agent",
            )
            expect(child?.body).toContain("deployed MCP accepts initialize")
            expect(child?.body).toContain(`HTTP ${deployedStatus}`)
            expect(child?.body).toContain("## Acceptance check")
            expect(child?.body).toContain("receive a protocolVersion")
            if (humanCheck) {
              expect(child?.body).toContain(
                "not a confirmed implementation defect",
              )
              expect(child?.body).not.toContain("Missing work")
            }
            expect(parentFindings).toContain(gapUrl("public-route"))
            expect(item.completionSummary).toContain(gapUrl("public-route"))
          }
          if (retryPublication) {
            expect(children.get("regional-route")).toMatchObject({
              requirementId: "mcp-deployed",
              label: "ready-for-human",
            })
            expect(parentFindings).toContain(gapUrl("regional-route"))
            expect(parentFindings).toContain(gapUrl("recovered-gap-1"))
            expect(parentFindings).toContain(gapUrl("recovered-gap-2"))
            expect(parentFindings).not.toContain("Follow-up not yet specified")
            expect(children.get("recovered-gap-1")?.body).toContain(
              "GET /health on the deployment returns HTTP 200",
            )
            expect(children.get("recovered-gap-2")?.body).toContain(
              "GET /readiness on the deployment returns HTTP 200",
            )
            expect(children.get("public-route")?.body).not.toContain(
              "region/mcp",
            )
            if (mixedEvidence) {
              expect(children.get("regional-route")?.body).toContain(
                "not a confirmed implementation defect",
              )
              expect(children.get("regional-route")?.body).toContain("HTTP 403")
            }
            expect(
              JSON.parse(row!.spec_validation_findings)[1].followUpLinks,
            ).toEqual([
              { gapId: "public-route", url: gapUrl("public-route") },
              { gapId: "regional-route", url: gapUrl("regional-route") },
            ])
          }
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
            requirement: "deployed MCP accepts initialize",
            environment: "deployed",
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
        "https://example.com/spec/1",
      ),
    )
    expect(findings.find(({ id }) => id === "mcp-deployed")?.status).toBe(
      "unverified",
    )
  }
})

it("keeps an explicit human-access check recoverable without an ID or a drafted task", async () => {
  const findings = await Effect.runPromise(
    decodeSpecFindings(
      `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify([
        {
          requirementId: "mcp-deployed",
          requirement: "deployed MCP accepts initialize",
          environment: "deployed",
          status: "unverified",
          evidence: [
            {
              kind: "human-access",
              environment: "deployed",
              detail:
                "Only the operator can run initialize with their production credentials.",
            },
            {
              kind: "unavailable",
              environment: "deployed",
              detail: "The public version could not be identified.",
            },
          ],
        },
      ])}`,
      "https://example.com/spec/1",
    ),
  )
  expect(findings.find(({ id }) => id === "mcp-deployed")).toMatchObject({
    status: "unverified",
    followUps: [],
    evidence: [
      { kind: "human-access", gapId: "recovered-gap-1" },
      { kind: "unavailable" },
    ],
  })
  expect(
    findings.find(({ id }) => id === "mcp-deployed")?.evidence[1],
  ).not.toHaveProperty("gapId")
})

it("does not convert unavailable evidence into a defect even if a fix is proposed", async () => {
  const findings = await Effect.runPromise(
    decodeSpecFindings(
      `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify([
        {
          requirementId: "mcp-deployed",
          requirement: "deployed MCP accepts initialize",
          environment: "deployed",
          status: "unmet",
          evidence: [
            {
              kind: "unavailable",
              environment: "deployed",
              detail: "Operator access required",
              gapId: "public-route",
            },
          ],
          followUps: [
            {
              gapId: "public-route",
              kind: "fix",
              owner: "agent",
              title: "Replace endpoint",
              task: "Replace endpoint",
              acceptanceCheck: "Initialize successfully",
            },
          ],
        },
      ])}`,
      "https://example.com/spec/1",
    ),
  )
  expect(findings.find(({ id }) => id === "mcp-deployed")).toMatchObject({
    status: "unverified",
  })
  expect(findings.find(({ id }) => id === "mcp-deployed")?.followUps).toEqual(
    [],
  )
})

it("treats duplicate requirement IDs as unverified", async () => {
  const entry = {
    requirementId: "mcp-local",
    requirement: "local MCP accepts initialize",
    environment: "local",
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
      `READY_FOR_AGENT_SPEC_FINDINGS:\n${JSON.stringify([entry, entry])}`,
      "https://example.com/spec/1",
    ),
  )
  expect(findings.map(({ id, status }) => [id, status])).toEqual([
    ["mcp-local", "unverified"],
  ])
  expect(findings[0]?.evidence[0]?.detail).toContain("more than once")
})
