import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { LIFECYCLE_STEP_AGENT_FREE } from "@ready-for-agent/lifecycle-model"
import {
  type TimingHistoryFilter,
  agentFreeLifecycleSteps,
  loadTimingHistory,
} from "../src/lib/timing-history.js"
import { describe, expect, it } from "bun:test"

describe("completed timing history SQL", () => {
  it("filters by completion/repository, retains old attempts, includes zero-history tasks, and excludes other outcomes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        for (const id of ["a", "b"]) {
          yield* sql.unsafe(
            `INSERT INTO repository (id, forge, forge_host, project_path, local_path, is_bare, paused, created_at, updated_at) VALUES (?, 'github', 'github.com', ?, ?, 1, 1, 0, 0)`,
            [id, `owner/${id}`, `/tmp/${id}`],
          )
        }
        for (const [id, repository, state, completion] of [
          ["included", "a", "complete", 2000],
          ["empty", "a", "complete", 2500],
          ["other", "b", "complete", 2000],
          ["old", "a", "complete", 999],
          ["boundary", "a", "complete", 3000],
          ["abandoned", "a", "abandoned", 2000],
          ["failed", "a", "failed", 2000],
        ] satisfies [string, string, string, number][]) {
          yield* sql.unsafe(
            `INSERT INTO work_item (id, repository_id, issue_number, issue_display_id, issue_title, state, state_ready_at, created_at, updated_at) VALUES (?, ?, 1, 'RFA-1', 'Recorded title', ?, ?, 0, ?)`,
            [id, repository, state, completion, completion],
          )
        }
        for (const [id, status, start, end] of [
          ["first", "failed", 100, 500],
          ["retry", "succeeded", 600, 1500],
        ] satisfies [string, string, number, number][]) {
          yield* sql.unsafe(
            `INSERT INTO step_run (id, work_item_id, step, status, queued_at, started_at, finished_at, session_wait_ms, created_at, updated_at) VALUES (?, 'included', 'pre_commit', ?, ?, ?, ?, 25, 0, ?)`,
            [id, status, start - 10, start, end, end],
          )
        }
        const filter: TimingHistoryFilter = {
          repositoryId: "a",
          fromMs: 1000,
          toMs: 3000,
          agentBackend: null,
          model: null,
          unknownModel: false,
        }
        const plan = yield* sql.unsafe(
          `EXPLAIN QUERY PLAN SELECT id FROM work_item
           WHERE state = 'complete' AND state_ready_at >= ? AND state_ready_at < ?`,
          [filter.fromMs, filter.toMs],
        )
        expect(JSON.stringify(plan)).toContain(
          "work_item_complete_ready_at_idx",
        )
        const result = yield* loadTimingHistory(sql, filter)
        expect(result.items.map((row) => row.id)).toEqual(["empty", "included"])
        expect(result.items[0]?.attempts).toEqual([])
        expect(result.items[1]).toMatchObject({
          repository: "owner/a",
          displayId: "RFA-1",
          title: "Recorded title",
          completedAt: 2000,
        })
        expect(
          result.items[1]?.attempts.map((a) => [
            a.id,
            a.startedAt,
            a.finishedAt,
            a.sessionWaitMs,
          ]),
        ).toEqual([
          ["first", 100, 500, 25],
          ["retry", 600, 1500, 25],
        ])
        expect(
          (yield* loadTimingHistory(sql, {
            ...filter,
            repositoryId: null,
          })).items.map((r) => r.id),
        ).toContain("other")
        expect(
          (yield* loadTimingHistory(sql, {
            ...filter,
            fromMs: null,
          })).items.map((r) => r.id),
        ).toContain("old")
        expect(
          (yield* loadTimingHistory(sql, {
            ...filter,
            repositoryId: "' OR 1=1 --",
          })).items,
        ).toEqual([])
      }).pipe(Effect.provide(DatabaseTest)),
    )
  })

  it("keeps agent-free steps aligned with the lifecycle model", () => {
    const free = new Set(agentFreeLifecycleSteps())
    for (const [step, isFree] of Object.entries(LIFECYCLE_STEP_AGENT_FREE)) {
      expect(free.has(step)).toBe(isFree)
    }
  })

  it("filters the Complete cohort by backend and model without multiplying attempts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `INSERT INTO repository (id, forge, forge_host, project_path, local_path, is_bare, paused, created_at, updated_at) VALUES ('repo', 'github', 'github.com', 'owner/repo', '/tmp/repo', 1, 1, 0, 0)`,
        )
        const insertItem = (
          id: string,
          state: string,
          completion: number,
          backend: string,
          profileModel: string | null = null,
        ) =>
          sql.unsafe(
            `INSERT INTO work_item (
               id, repository_id, issue_number, state, state_ready_at,
               agent_backend, execution_profile_present, execution_profile_build_model,
               created_at, updated_at
             ) VALUES (?, 'repo', 1, ?, ?, ?, ?, ?, 0, ?)`,
            [
              id,
              state,
              completion,
              backend,
              profileModel === null ? 0 : 1,
              profileModel,
              completion,
            ],
          )
        const insertRun = (
          id: string,
          workItemId: string,
          step: string,
          queuedAt: number,
        ) =>
          sql.unsafe(
            `INSERT INTO step_run (
               id, work_item_id, step, status, queued_at, started_at, finished_at,
               session_wait_ms, created_at, updated_at
             ) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, 0, 0, ?)`,
            [
              id,
              workItemId,
              step,
              queuedAt,
              queuedAt + 10,
              queuedAt + 100,
              queuedAt,
            ],
          )
        const insertModel = (
          id: string,
          stepRunId: string,
          role: string,
          model: string,
        ) =>
          sql.unsafe(
            `INSERT INTO step_run_agent_model (id, step_run_id, role, model, created_at) VALUES (?, ?, ?, ?, 0)`,
            [id, stepRunId, role, model],
          )

        yield* insertItem("mixed", "complete", 2000, "opencode")
        yield* insertRun("mixed-old", "mixed", "implement", 100)
        yield* insertRun("mixed-review", "mixed", "review", 1500)
        yield* insertRun("mixed-free", "mixed", "create_worktree", 50)
        yield* insertModel(
          "m1",
          "mixed-old",
          "build",
          "anthropic/claude-sonnet",
        )
        yield* insertModel(
          "m2",
          "mixed-review",
          "review",
          "anthropic/claude-sonnet",
        )
        yield* insertModel("m3", "mixed-review", "build", "openai/gpt-5")

        yield* insertItem("repeat", "complete", 2100, "opencode")
        yield* insertRun("repeat-1", "repeat", "implement", 200)
        yield* insertRun("repeat-2", "repeat", "implement", 300)
        yield* insertModel("r1", "repeat-1", "build", "openai/gpt-5")
        yield* insertModel("r2", "repeat-2", "build", "openai/gpt-5")

        yield* insertItem("unknown", "complete", 2200, "codex")
        yield* insertRun("unknown-run", "unknown", "implement", 400)

        yield* insertItem("partial", "complete", 2300, "opencode")
        yield* insertRun("partial-known", "partial", "implement", 500)
        yield* insertRun("partial-missing", "partial", "review", 600)
        yield* insertModel(
          "p1",
          "partial-known",
          "build",
          "anthropic/claude-haiku",
        )

        yield* insertItem(
          "profile",
          "complete",
          2400,
          "opencode",
          "profile-only",
        )
        yield* insertRun("profile-run", "profile", "implement", 700)

        yield* insertItem("failed", "failed", 2000, "opencode")
        yield* insertRun("failed-run", "failed", "implement", 800)
        yield* insertModel("f1", "failed-run", "build", "should-not-appear")
        yield* insertItem("abandoned", "abandoned", 2000, "grok")
        yield* insertItem("open", "implement", 2000, "opencode")

        yield* insertItem("other-backend", "complete", 2500, "codex")
        yield* insertRun("other-run", "other-backend", "implement", 900)
        yield* insertModel(
          "o1",
          "other-run",
          "build",
          "anthropic/claude-sonnet",
        )

        const base: TimingHistoryFilter = {
          repositoryId: "repo",
          fromMs: 1000,
          toMs: 3000,
          agentBackend: null,
          model: null,
          unknownModel: false,
        }
        const ids = (filter: TimingHistoryFilter) =>
          loadTimingHistory(sql, filter).pipe(
            Effect.map((result) => result.items.map((item) => item.id)),
          )

        const all = yield* loadTimingHistory(sql, base)
        expect(all.items.map((item) => item.id)).toEqual([
          "other-backend",
          "profile",
          "partial",
          "unknown",
          "repeat",
          "mixed",
        ])
        expect(all.choices.agentBackends).toEqual(["codex", "opencode"])
        expect(all.choices.models).toEqual([
          { agentBackend: "codex", model: "anthropic/claude-sonnet" },
          { agentBackend: "opencode", model: "anthropic/claude-haiku" },
          { agentBackend: "opencode", model: "anthropic/claude-sonnet" },
          { agentBackend: "opencode", model: "openai/gpt-5" },
        ])
        expect(all.choices.hasUnknownModel).toBe(true)
        expect(all.choices.models.map((choice) => choice.model)).not.toContain(
          "profile-only",
        )
        expect(all.choices.models.map((choice) => choice.model)).not.toContain(
          "should-not-appear",
        )

        const mixed = all.items.find((item) => item.id === "mixed")
        expect(mixed?.attempts.map((attempt) => attempt.id)).toEqual([
          "mixed-free",
          "mixed-old",
          "mixed-review",
        ])
        expect(mixed?.models).toEqual([
          "anthropic/claude-sonnet",
          "openai/gpt-5",
        ])
        expect(mixed?.modelHistory).toBe("complete")
        expect(
          all.items.find((item) => item.id === "repeat")?.attempts,
        ).toHaveLength(2)
        expect(
          all.items.find((item) => item.id === "unknown")?.modelHistory,
        ).toBe("unknown")
        expect(all.items.find((item) => item.id === "partial")).toMatchObject({
          modelHistory: "partial",
          models: ["anthropic/claude-haiku"],
        })
        expect(
          all.items.find((item) => item.id === "profile")?.modelHistory,
        ).toBe("unknown")

        expect(yield* ids({ ...base, agentBackend: "codex" })).toEqual([
          "other-backend",
          "unknown",
        ])
        expect(yield* ids({ ...base, model: "openai/gpt-5" })).toEqual([
          "repeat",
          "mixed",
        ])
        expect(
          yield* ids({
            ...base,
            agentBackend: "opencode",
            model: "anthropic/claude-sonnet",
          }),
        ).toEqual(["mixed"])
        expect(
          yield* ids({ ...base, model: "anthropic/claude-sonnet" }),
        ).toEqual(["other-backend", "mixed"])
        expect(yield* ids({ ...base, unknownModel: true })).toEqual([
          "profile",
          "unknown",
        ])
        expect(yield* ids({ ...base, model: "missing-model" })).toEqual([])
        const noMatch = yield* loadTimingHistory(sql, {
          ...base,
          model: "missing-model",
        })
        expect(noMatch.choices.models.map((choice) => choice.model)).toContain(
          "openai/gpt-5",
        )
        expect(yield* ids({ ...base, agentBackend: "' OR 1=1 --" })).toEqual([])
        expect(yield* ids({ ...base, model: "' OR 1=1 --" })).toEqual([])
        const backendScoped = yield* loadTimingHistory(sql, {
          ...base,
          agentBackend: "codex",
        })
        expect(backendScoped.choices.agentBackends).toEqual([
          "codex",
          "opencode",
        ])
      }).pipe(Effect.provide(DatabaseTest)),
    )
  })
})
