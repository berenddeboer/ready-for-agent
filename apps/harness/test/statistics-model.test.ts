import { OPERATIONAL_LIFECYCLE_STEPS } from "@ready-for-agent/lifecycle-model"
import {
  describeTimes,
  laneStatistics,
  measureAttempts,
  projectTimingTask,
  stepStatistics,
} from "../src/statistics-model.js"
import type { TimingWorkItem } from "../src/statistics-query.js"
import { describe, expect, test } from "bun:test"

const attempt = (
  id: string,
  step: string,
  startedAt: number | null,
  finishedAt: number | null,
  status = "succeeded",
): TimingWorkItem["attempts"][number] => ({
  id,
  step,
  status,
  queuedAt: startedAt === null ? 0 : Math.max(0, startedAt - 1000),
  startedAt,
  finishedAt,
  reasonCode: null,
  sessionWaitMs: 0,
})
const item = (
  id: string,
  attempts: TimingWorkItem["attempts"],
): TimingWorkItem => ({
  id,
  repositoryId: "repo",
  repository: "owner/repo",
  displayId: id,
  title: id,
  origin: "issue",
  createdAt: 0,
  completedAt: 1_000_000,
  attempts,
})

describe("timing statistics", () => {
  test("every operational lifecycle step contributes to exactly one lane", () => {
    for (const step of OPERATIONAL_LIFECYCLE_STEPS) {
      const task = projectTimingTask(item(step, [attempt(step, step, 0, 1000)]))
      expect(
        Object.values(task.lanes).filter((lane) => lane.executionMs === 1000),
      ).toHaveLength(1)
      expect(stepStatistics([task])[0]?.lane).not.toBeNull()
    }
  })

  test("sums failed and successful attempts per task; per-attempt and per-task means differ", () => {
    const tasks = [
      projectTimingTask(
        item("one", [
          attempt("first", "pre_commit", 1000, 601000, "failed"),
          attempt("retry", "pre_commit", 602000, 722000),
        ]),
      ),
      projectTimingTask(
        item("two", [attempt("other", "pre_commit", 1000, 61000)]),
      ),
    ]
    const step = stepStatistics(tasks)[0]
    expect(step?.perTask).toEqual({
      count: 2,
      total: 780000,
      average: 390000,
      median: 390000,
      p90: 654000,
    })
    expect(step?.perAttempt.average).toBe(260000)
    expect(step?.repeats).toBe(1)
    expect(step?.repeatMs).toBe(120000)
    expect(step?.failures).toBe(1)
    expect(laneStatistics(tasks, "build").average).toBe(390000)
    expect(laneStatistics(tasks, "review").count).toBe(0)
  })

  test("polls, throttle postponements and cancelled-before-start runs are not retry work", () => {
    const rows = [
      attempt("cancel", "review", null, 500, "cancelled"),
      attempt("hold", "review", 1000, 2000, "postponed"),
      attempt("review", "review", 3000, 8000),
      attempt("watch1", "watch_pr_status_checks", 9000, 10000),
      attempt("watch2", "watch_pr_status_checks", 11000, 12000),
    ]
    expect(measureAttempts(rows)).toMatchObject({
      executionMs: 8000,
      repeatMs: 0,
      repeats: 0,
      timed: 4,
      missing: 0,
    })
  })

  test("missing and reversed execution stamps are unknown, never zero or a partial average", () => {
    const tasks = [
      projectTimingTask(
        item("partial", [
          attempt("valid", "pre_commit", 0, 60000),
          attempt("missing", "pre_commit", 61000, null, "failed"),
        ]),
      ),
      projectTimingTask(item("empty", [])),
      projectTimingTask(
        item("bad", [attempt("reverse", "pre_commit", 100, 50)]),
      ),
    ]
    expect(tasks.map((t) => t.executionMs)).toEqual([null, null, null])
    expect(tasks[0]?.recordedMs).toBe(60000)
    expect(stepStatistics(tasks)[0]?.perTask.count).toBe(0)
    expect(stepStatistics(tasks)[0]?.perAttempt.average).toBe(60000)
    expect(describeTimes([])).toMatchObject({
      count: 0,
      average: null,
      median: null,
      p90: null,
    })
    expect(
      measureAttempts([attempt("zero", "pre_commit", 0, 0)]).executionMs,
    ).toBe(0)
  })

  test("retains start-to-finish semantics without subtracting session waits or inventing human waits", () => {
    const row = {
      ...attempt("wait", "review", 2000, 62000),
      sessionWaitMs: 10000,
    }
    const projected = projectTimingTask(item("one", [row]))
    expect(projected).toMatchObject({
      executionMs: 60000,
      sessionWaitMs: 10000,
      queueMs: 1000,
      elapsedMs: 1000000,
    })
  })

  test("repeats are per step, not the second distinct step in the same lane", () => {
    expect(
      measureAttempts([
        attempt("a", "create_worktree", 0, 10),
        attempt("b", "implement", 20, 50),
        attempt("c", "pre_commit", 60, 70),
      ]).repeats,
    ).toBe(0)
  })
})
