import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { loadTimingHistory } from "../src/lib/timing-history.js"
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
        const filter = { repositoryId: "a", fromMs: 1000, toMs: 3000 }
        const plan = yield* sql.unsafe(
          `EXPLAIN QUERY PLAN SELECT id FROM work_item
           WHERE state = 'complete' AND state_ready_at >= ? AND state_ready_at < ?`,
          [filter.fromMs, filter.toMs],
        )
        expect(JSON.stringify(plan)).toContain(
          "work_item_complete_ready_at_idx",
        )
        const result = yield* loadTimingHistory(sql, filter)
        expect(result.map((row) => row.id)).toEqual(["empty", "included"])
        expect(result[0]?.attempts).toEqual([])
        expect(result[1]).toMatchObject({
          repository: "owner/a",
          displayId: "RFA-1",
          title: "Recorded title",
          completedAt: 2000,
        })
        expect(
          result[1]?.attempts.map((a) => [
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
          })).map((r) => r.id),
        ).toContain("other")
        expect(
          (yield* loadTimingHistory(sql, { ...filter, fromMs: null })).map(
            (r) => r.id,
          ),
        ).toContain("old")
        expect(
          yield* loadTimingHistory(sql, {
            ...filter,
            repositoryId: "' OR 1=1 --",
          }),
        ).toEqual([])
      }).pipe(Effect.provide(DatabaseTest)),
    )
  })
})
