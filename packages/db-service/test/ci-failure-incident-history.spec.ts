import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  type CiFailureIncidentRecord,
  DbService,
  DbServiceLive,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("resolved CI Failure Incident history query", () => {
  const TestLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
  const runTest = <A, E>(
    test: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>,
  ): Promise<A> => Effect.runPromise(Effect.provide(test, TestLayer))

  const cutoff = Date.parse("2026-11-05T00:00:00.000Z")

  const incident = (input: {
    readonly id: string
    readonly repositoryId: string
    readonly status: "open" | "resolved"
    readonly openedAt: number
    readonly resolvedAt: number | null
    readonly summary: string
    readonly label: string
  }): CiFailureIncidentRecord => ({
    id: input.id,
    repositoryId: input.repositoryId,
    status: input.status,
    openedAt: new Date(input.openedAt),
    resolvedAt: input.resolvedAt === null ? null : new Date(input.resolvedAt),
    recoveryReason: input.status === "resolved" ? "newer_success" : null,
    summary: input.summary,
    definitions: [
      {
        identity: "ci.yml",
        displayLabel: input.label,
        firstFailedRunIdentity: `${input.id}:1`,
        firstFailedRunHtmlUrl: `https://example.test/${input.id}`,
        joinedAt: new Date(input.openedAt),
      },
    ],
  })

  it("windows resolved incidents without dropping stored rows or latest resolved", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-history.git",
          isBare: true,
        })
        const outside = incident({
          id: "cfi-outside",
          repositoryId: repository.id,
          status: "resolved",
          openedAt: cutoff - 40 * 24 * 60 * 60 * 1000,
          resolvedAt: cutoff - 1,
          summary: "Resolved just outside the window.",
          label: "Outside",
        })
        const atCutoff = incident({
          id: "cfi-cutoff",
          repositoryId: repository.id,
          status: "resolved",
          openedAt: cutoff - 20 * 24 * 60 * 60 * 1000,
          resolvedAt: cutoff,
          summary: "Resolved at the cutoff.",
          label: "Cutoff",
        })
        const recentOld = incident({
          id: "cfi-recent-old",
          repositoryId: repository.id,
          status: "resolved",
          openedAt: cutoff - 30 * 24 * 60 * 60 * 1000,
          resolvedAt: cutoff + 6 * 24 * 60 * 60 * 1000,
          summary: "Resolved recently after an old opening.",
          label: "Recent old",
        })
        const middle = incident({
          id: "cfi-middle",
          repositoryId: repository.id,
          status: "resolved",
          openedAt: cutoff - 3 * 24 * 60 * 60 * 1000,
          resolvedAt: cutoff + 2 * 24 * 60 * 60 * 1000,
          summary: "Resolved in the middle of the window.",
          label: "Middle",
        })
        const undated = incident({
          id: "cfi-undated",
          repositoryId: repository.id,
          status: "resolved",
          openedAt: cutoff + 24 * 60 * 60 * 1000,
          resolvedAt: null,
          summary: "Resolved date missing.",
          label: "Undated",
        })
        const active = incident({
          id: "cfi-active",
          repositoryId: repository.id,
          status: "open",
          openedAt: cutoff - 30 * 24 * 60 * 60 * 1000,
          resolvedAt: null,
          summary: "CI Gate closed: CI failed.",
          label: "Active",
        })
        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "trunk",
          lastObservedAt: new Date(cutoff + 6 * 24 * 60 * 60 * 1000),
          observations: [],
          incidentsToUpsert: [
            outside,
            atCutoff,
            middle,
            recentOld,
            undated,
            active,
          ],
        })

        const listed = yield* db.listResolvedCiFailureIncidents(repository.id, {
          resolvedSinceMs: cutoff,
        })
        expect(listed.map((entry) => entry.id)).toEqual([
          "cfi-recent-old",
          "cfi-middle",
          "cfi-cutoff",
        ])
        expect(listed[0]?.definitions[0]?.displayLabel).toBe("Recent old")
        expect(listed[0]?.openedAt.toISOString()).toBe(
          recentOld.openedAt.toISOString(),
        )
        expect(listed.some((entry) => entry.summary === outside.summary)).toBe(
          false,
        )
        expect(listed.some((entry) => entry.id === "cfi-active")).toBe(false)
        expect(listed.some((entry) => entry.id === "cfi-undated")).toBe(false)

        const snapshot = yield* db.loadCiGateSnapshot(repository.id)
        expect(snapshot.activeIncident?.id).toBe("cfi-active")
        expect(snapshot.latestResolvedIncident?.id).toBe("cfi-recent-old")

        const stored = (yield* sql.unsafe(
          `SELECT id FROM ci_failure_incident WHERE repository_id = ?`,
          [repository.id],
        )) as readonly { readonly id: string }[]
        expect(stored.map((row) => row.id).sort()).toEqual(
          [
            "cfi-active",
            "cfi-cutoff",
            "cfi-middle",
            "cfi-outside",
            "cfi-recent-old",
            "cfi-undated",
          ].sort(),
        )
      }),
    ))

  it("keeps the newest resolved incident when it is outside the history window", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const repository = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/old",
          localPath: "/repos/acme/old-history.git",
          isBare: true,
        })
        yield* db.commitCiGateSnapshot({
          repositoryId: repository.id,
          defaultBranch: "trunk",
          lastObservedAt: new Date(cutoff - 8 * 24 * 60 * 60 * 1000),
          observations: [],
          incidentsToUpsert: [
            incident({
              id: "cfi-only-old",
              repositoryId: repository.id,
              status: "resolved",
              openedAt: cutoff - 40 * 24 * 60 * 60 * 1000,
              resolvedAt: cutoff - 8 * 24 * 60 * 60 * 1000,
              summary: "Resolved long before the window.",
              label: "Old",
            }),
          ],
        })

        const listed = yield* db.listResolvedCiFailureIncidents(repository.id, {
          resolvedSinceMs: cutoff,
        })
        expect(listed).toEqual([])
        const snapshot = yield* db.loadCiGateSnapshot(repository.id)
        expect(snapshot.latestResolvedIncident?.id).toBe("cfi-only-old")
        expect(snapshot.latestResolvedIncident?.summary).toBe(
          "Resolved long before the window.",
        )
        expect(snapshot.activeIncident).toBeNull()
        const stored = (yield* sql.unsafe(
          `SELECT id FROM ci_failure_incident WHERE repository_id = ?`,
          [repository.id],
        )) as readonly { readonly id: string }[]
        expect(stored.map((row) => row.id)).toEqual(["cfi-only-old"])
      }),
    ))
})
