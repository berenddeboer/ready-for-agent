import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Duration, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbServiceLive } from "@ready-for-agent/db-service"
import {
  Opencode,
  OpencodeExitError,
  OpencodeTimeoutError,
  SessionIdNotFoundError,
} from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "../src/index.js"
import {
  CurrentStepRun,
  MAX_REVIEW_FIX_ROUNDS,
  PreCommitOpenCodeError,
  REVIEW_AGENT_COMMAND,
  REVIEW_APPLYING_FINDINGS_MESSAGE,
  REVIEW_ASSESSING_RERUN_MESSAGE,
  REVIEW_FIX_LIMIT_REASON,
  REVIEW_HIGH_UNCHANGED_REASON,
  REVIEW_PRE_COMMIT_MESSAGE,
  REVIEW_UNRESOLVED_HIGH_REASON,
  ReviewInvalidWorktreeContextError,
  ReviewOpenCodeError,
  ReviewResultError,
  ReviewSessionContextMissingError,
  ReviewWorktreeContextMissingError,
  STEP_RUN_REASON,
  buildRerunAssessmentPrompt,
  buildReviewingPrompt,
  formatAcceptedReviewSummary,
  formatDeferredReviewSummary,
  makeWorkItemId,
  parseApplyReviewResult,
  parseRerunAssessmentResult,
  parseReviewResult,
  review,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const PlatformLayer = BunServices.layer

const baseContext = (
  worktreePath: string | null,
  overrides: Partial<LifecycleStepContext> = {},
): LifecycleStepContext => ({
  workItemId: makeWorkItemId(),
  repositoryId: "repo-test",
  githubIssueNumber: 91,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath,
  startingCommitOid: null,
  completionSummary: null,
  sessionId: "ses_implement_session",
  ...overrides,
})

const stubOpencode = (impl: {
  readonly start?: (input: {
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
    readonly timeout?: Duration.Input
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
  readonly continue?: (input: {
    readonly sessionId: string
    readonly prompt: string
    readonly cwd: string
    readonly model: string
    readonly variant: string
    readonly timeout?: Duration.Input
    readonly command?: string
  }) => Effect.Effect<{ sessionId: string; assistantText: string }, never>
}) =>
  Layer.succeed(
    Opencode,
    Opencode.of({
      start: (input) =>
        impl.start?.(input) ??
        Effect.succeed({
          sessionId: "ses_start_should_not_run",
          assistantText: "",
        }),
      continue: (input) =>
        impl.continue?.(input) ??
        Effect.succeed({
          sessionId: "ses_review_default",
          assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
        }),
      listModels: () => Effect.succeed([]),
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Opencode
    | Layer.Layer.Success<typeof PlatformLayer>
    | Layer.Layer.Success<typeof DbServiceLive>
    | Layer.Layer.Success<typeof DatabaseTest>
  >,
  opencodeLayer: Layer.Layer<Opencode, never, never> = stubOpencode({}),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(opencodeLayer),
      Effect.provide(DbServiceLive),
      Effect.provide(DatabaseTest),
      Effect.provide(PlatformLayer),
    ),
  )

const withTemp = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-review-"))
  try {
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const initGitRepo = async (root: string) => {
  const runGit = async (...args: string[]) => {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
    }
  }
  await runGit("init")
  await runGit("config", "user.email", "test@example.com")
  await runGit("config", "user.name", "Test")
  await runGit("commit", "--no-verify", "--allow-empty", "-m", "init")
}

const withTempGit = async (assert: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "rfa-review-git-"))
  try {
    await initGitRepo(root)
    await assert(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeHook = async (root: string, body: string) => {
  await mkdir(join(root, ".git", "hooks"), { recursive: true })
  await writeFile(join(root, ".git", "hooks", "pre-commit"), body, {
    mode: 0o755,
  })
}

describe("parseReviewResult", () => {
  it("parses clean and severity-tagged has-findings lines", () => {
    expect(parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_CLEAN")).toEqual({
      _tag: "clean",
    })
    expect(
      parseReviewResult(
        "Looks good overall.\nREADY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
      ),
    ).toEqual({ _tag: "has_findings", severity: "low" })
    expect(
      parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium"),
    ).toEqual({ _tag: "has_findings", severity: "medium" })
    expect(
      parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: high"),
    ).toEqual({ _tag: "has_findings", severity: "high" })
  })

  it("rejects missing, duplicate, non-final, unsevered, or unknown markers", () => {
    expect(parseReviewResult("no result line")).toBeNull()
    expect(
      parseReviewResult(
        [
          "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
          "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
        ].join("\n"),
      ),
    ).toBeNull()
    expect(
      parseReviewResult(
        "READY_FOR_AGENT_RESULT: REVIEW_CLEAN\nAdditional output",
      ),
    ).toBeNull()
    expect(
      parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS"),
    ).toBeNull()
    expect(
      parseReviewResult(
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: critical",
      ),
    ).toBeNull()
    expect(parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_FIXED")).toBeNull()
  })
})

describe("parseApplyReviewResult", () => {
  it("parses fixed, fixed-and-deferred, deferred, cleared, and unresolved-high lines", () => {
    expect(
      parseApplyReviewResult("READY_FOR_AGENT_RESULT: REVIEW_FIXED"),
    ).toEqual({ _tag: "fixed" })
    expect(
      parseApplyReviewResult(
        "Fixed main bug.\nREADY_FOR_AGENT_RESULT: REVIEW_FIXED_AND_DEFERRED: low: style nits remain",
      ),
    ).toEqual({
      _tag: "fixed_and_deferred",
      severity: "low",
      reason: "style nits remain",
    })
    expect(
      parseApplyReviewResult(
        "Left style notes.\nREADY_FOR_AGENT_RESULT: REVIEW_DEFERRED: medium: naming only",
      ),
    ).toEqual({
      _tag: "deferred",
      severity: "medium",
      reason: "naming only",
    })
    expect(
      parseApplyReviewResult(
        "Nothing actionable.\nREADY_FOR_AGENT_RESULT: REVIEW_CLEARED: false positive",
      ),
    ).toEqual({ _tag: "cleared", reason: "false positive" })
    expect(
      parseApplyReviewResult(
        "READY_FOR_AGENT_RESULT: REVIEW_UNRESOLVED_HIGH: auth bypass still open",
      ),
    ).toEqual({
      _tag: "unresolved_high",
      reason: "auth bypass still open",
    })
  })

  it("rejects missing, duplicate, blank, high-deferred, or reviewing-only markers", () => {
    expect(parseApplyReviewResult("no result line")).toBeNull()
    expect(
      parseApplyReviewResult(
        [
          "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
          "READY_FOR_AGENT_RESULT: REVIEW_CLEARED: x",
        ].join("\n"),
      ),
    ).toBeNull()
    expect(
      parseApplyReviewResult(
        "READY_FOR_AGENT_RESULT: REVIEW_FIXED\ntrailing prose",
      ),
    ).toBeNull()
    expect(
      parseApplyReviewResult("READY_FOR_AGENT_RESULT: REVIEW_DEFERRED:"),
    ).toBeNull()
    expect(
      parseApplyReviewResult("READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low:"),
    ).toBeNull()
    expect(
      parseApplyReviewResult(
        "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: high: cannot defer high",
      ),
    ).toBeNull()
    expect(
      parseApplyReviewResult("READY_FOR_AGENT_RESULT: REVIEW_CLEAN"),
    ).toBeNull()
    expect(
      parseApplyReviewResult(
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
      ),
    ).toBeNull()
  })

  it("bounds deferred and cleared reasons", () => {
    const long = "x".repeat(600)
    expect(
      parseApplyReviewResult(
        `READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: ${long}`,
      ),
    ).toEqual({
      _tag: "deferred",
      severity: "low",
      reason: long.slice(0, 500),
    })
    expect(
      parseApplyReviewResult(`READY_FOR_AGENT_RESULT: REVIEW_CLEARED: ${long}`),
    ).toEqual({ _tag: "cleared", reason: long.slice(0, 500) })
  })
})

describe("formatDeferredReviewSummary", () => {
  it("joins severity and reason for Step Run persistence", () => {
    expect(formatDeferredReviewSummary("low", "style nits")).toBe(
      "low: style nits",
    )
  })
})

describe("formatAcceptedReviewSummary", () => {
  it("persists acceptance rationale and optional deferred remainder", () => {
    expect(formatAcceptedReviewSummary("localized rename only", null)).toBe(
      "localized rename only",
    )
    expect(
      formatAcceptedReviewSummary("localized rename only", {
        severity: "low",
        reason: "style nits remain",
      }),
    ).toBe("localized rename only (deferred low: style nits remain)")
  })
})

describe("parseRerunAssessmentResult", () => {
  it("parses accepted-without-rerun and rerun-required lines", () => {
    expect(
      parseRerunAssessmentResult(
        "Looks narrow.\nREADY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED: direct rename only",
      ),
    ).toEqual({
      _tag: "accepted",
      reason: "direct rename only",
    })
    expect(
      parseRerunAssessmentResult(
        "READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: expanded into parser behavior",
      ),
    ).toEqual({
      _tag: "rerun_required",
      reason: "expanded into parser behavior",
    })
  })

  it("rejects missing, duplicate, blank, non-final, or foreign markers", () => {
    expect(parseRerunAssessmentResult("no result line")).toBeNull()
    expect(
      parseRerunAssessmentResult(
        [
          "READY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED: a",
          "READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: b",
        ].join("\n"),
      ),
    ).toBeNull()
    expect(
      parseRerunAssessmentResult(
        "READY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED: ok\ntrailing",
      ),
    ).toBeNull()
    expect(
      parseRerunAssessmentResult(
        "READY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED:",
      ),
    ).toBeNull()
    expect(
      parseRerunAssessmentResult("READY_FOR_AGENT_RESULT: REVIEW_FIXED"),
    ).toBeNull()
    expect(
      parseRerunAssessmentResult("READY_FOR_AGENT_RESULT: REVIEW_CLEAN"),
    ).toBeNull()
  })

  it("bounds assessment reasons", () => {
    const long = "x".repeat(600)
    expect(
      parseRerunAssessmentResult(
        `READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: ${long}`,
      ),
    ).toEqual({ _tag: "rerun_required", reason: long.slice(0, 500) })
  })
})

const isReviewingTurn = (input: {
  readonly command?: string
  readonly prompt: string
}): boolean =>
  input.command === REVIEW_AGENT_COMMAND ||
  input.prompt === buildReviewingPrompt()

const isAssessmentTurn = (input: { readonly prompt: string }): boolean =>
  input.prompt === buildRerunAssessmentPrompt() ||
  input.prompt.includes("REVIEW_RERUN_NOT_REQUIRED")

describe("buildReviewingPrompt", () => {
  it("forbids edits, defines the severity rubric, and requires the result contract", () => {
    const prompt = buildReviewingPrompt()
    expect(prompt).toContain("Review uncommitted worktree changes.")
    expect(prompt).toContain(
      "Do not edit files, commit, push, open pull requests, or apply findings in this turn.",
    )
    expect(prompt).toContain("low = no plausible runtime or contract impact")
    expect(prompt).toContain("medium = bounded behavior or correctness impact")
    expect(prompt).toContain(
      "high = security, data-loss, major-contract, or broad/systemic impact",
    )
    expect(prompt).toContain("READY_FOR_AGENT_RESULT: REVIEW_CLEAN")
    expect(prompt).toContain(
      "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: <low|medium|high>",
    )
    expect(prompt.startsWith('"')).toBe(false)
    expect(prompt.endsWith('"')).toBe(false)
    expect(prompt.startsWith("/review")).toBe(false)
    expect(REVIEW_AGENT_COMMAND).toBe("/review")
  })
})

describe("review", () => {
  it("rejects missing worktree context", async () => {
    const error = await run(review(baseContext(null)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ReviewWorktreeContextMissingError)
  })

  it("rejects a worktree path that does not exist", async () => {
    const missing = join(tmpdir(), "rfa-review-missing-worktree")
    const error = await run(review(baseContext(missing)).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ReviewInvalidWorktreeContextError)
  })

  it("rejects missing Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root, { sessionId: null })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(ReviewSessionContextMissingError)
    }))

  it("rejects blank Session context", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root, { sessionId: "   " })).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(ReviewSessionContextMissingError)
    }))

  it("continues the Implement Session with /review contract and review model", () =>
    withTemp(async (root) => {
      let continued: {
        sessionId: string
        prompt: string
        cwd: string
        model: string
        variant: string
        timeout?: Duration.Input
        command?: string
      } | null = null
      let started = false

      const result = await run(
        review(
          baseContext(root, {
            sessionId: "ses_from_implement",
            model: "opencode/build-model",
            variant: "high",
            reviewModel: "opencode/review-model",
            reviewVariant: "max",
            maxDuration: Duration.minutes(45),
          }),
        ),
        stubOpencode({
          start: () => {
            started = true
            return Effect.succeed({ sessionId: "ses_wrong", assistantText: "" })
          },
          continue: (input) => {
            continued = input
            return Effect.succeed({
              sessionId: "ses_from_implement",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            })
          },
        }),
      )

      expect(started).toBe(false)
      expect(result).toEqual({ _tag: "clean" })
      expect(continued).not.toBeNull()
      expect(continued!.sessionId).toBe("ses_from_implement")
      expect(continued!.cwd).toBe(root)
      expect(continued!.model).toBe("opencode/review-model")
      expect(continued!.variant).toBe("max")
      expect(Duration.toMillis(continued!.timeout!)).toBe(
        Duration.toMillis(Duration.minutes(45)),
      )
      expect(continued!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continued!.prompt).toBe(buildReviewingPrompt())
      expect(continued!.prompt.startsWith('"')).toBe(false)
      expect(continued!.prompt.endsWith('"')).toBe(false)
      expect(continued!.prompt.startsWith("/review")).toBe(false)
      expect(continued!.prompt).toContain(
        "Do not edit files, commit, push, open pull requests, or apply findings",
      )
      expect(continued!.prompt).toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
      )
      expect(continued!.prompt).toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: <low|medium|high>",
      )
      expect(continued!.prompt).toContain(
        "low = no plausible runtime or contract impact",
      )
    }))

  it("returns clean for a unique final REVIEW_CLEAN marker", () =>
    withTemp(async (root) => {
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "No issues found.\nREADY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            }),
        }),
      )
      expect(result).toEqual({ _tag: "clean" })
    }))

  it("requests a verdict when /review summarizes a nested clean result without its marker", () =>
    withTemp(async (root) => {
      const continues: Array<{ prompt: string; command?: string }> = []
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            continues.push({
              prompt: input.prompt,
              ...(input.command !== undefined
                ? { command: input.command }
                : {}),
            })
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                continues.length === 1
                  ? "Review clean: no findings."
                  : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            })
          },
        }),
      )

      expect(result).toEqual({ _tag: "clean" })
      expect(continues).toHaveLength(2)
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[1]!.command).toBeUndefined()
      expect(continues[1]!.prompt).toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
      )
      expect(continues[1]!.prompt).toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: <low|medium|high>",
      )
      expect(continues[1]!.prompt).toContain(
        "low = no plausible runtime or contract impact",
      )
    }))

  it("enters a Review Fix Round from normalized /review child findings (not parent REVIEW_FIXED)", () =>
    withTemp(async (root) => {
      // Models the OpenCode adapter contract after #439: command turns return
      // only the nested reviewer text, never the automatic parent resume.
      const normalizedChildReview = [
        "## Review Findings",
        "- Medium: example finding",
        "",
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
      ].join("\n")
      const continues: Array<{ command?: string; prompt: string }> = []
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            continues.push({
              prompt: input.prompt,
              ...(input.command !== undefined
                ? { command: input.command }
                : {}),
            })
            if (input.command === REVIEW_AGENT_COMMAND) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText: normalizedChildReview,
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: medium: follow-up",
            })
          },
        }),
      )

      expect(result).toEqual({
        _tag: "deferred",
        severity: "medium",
        reason: "follow-up",
      })
      expect(continues).toHaveLength(2)
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[1]!.command).toBeUndefined()
      expect(continues[1]!.prompt).toContain("Interpret those findings")
      expect(continues[1]!.prompt).toContain("REVIEW_HAS_FINDINGS: medium")
      // Parent resume marker must not be accepted as the reviewing outcome.
      expect(parseReviewResult("READY_FOR_AGENT_RESULT: REVIEW_FIXED")).toBe(
        null,
      )
    }))

  it("classifies severity on the fallback verdict without another /review command", () =>
    withTemp(async (root) => {
      const continues: Array<{
        prompt: string
        command?: string
        model: string
      }> = []
      const result = await run(
        review(
          baseContext(root, {
            reviewModel: "opencode/review-model",
            model: "opencode/build-model",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            continues.push({
              prompt: input.prompt,
              model: input.model,
              ...(input.command !== undefined
                ? { command: input.command }
                : {}),
            })
            if (continues.length === 1) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "Found a bounded correctness issue in the parser.",
              })
            }
            if (continues.length === 2) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: medium: follow-up ticket",
            })
          },
        }),
      )

      expect(result).toEqual({
        _tag: "deferred",
        severity: "medium",
        reason: "follow-up ticket",
      })
      expect(continues).toHaveLength(3)
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[0]!.model).toBe("opencode/review-model")
      expect(continues[1]!.command).toBeUndefined()
      expect(continues[1]!.model).toBe("opencode/review-model")
      expect(continues[1]!.prompt).toContain("Do not review again")
      expect(continues[2]!.model).toBe("opencode/build-model")
    }))

  it("applies findings with build model when reviewing reports HAS_FINDINGS", () =>
    withTemp(async (root) => {
      const continues: Array<{
        model: string
        variant: string
        prompt: string
        command?: string
      }> = []

      const result = await run(
        review(
          baseContext(root, {
            model: "opencode/build-model",
            variant: "high",
            reviewModel: "opencode/review-model",
            reviewVariant: "max",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            continues.push({
              model: input.model,
              variant: input.variant,
              prompt: input.prompt,
              command: input.command,
            })
            if (continues.length === 1) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "Found a bug.\nREADY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "Deferred style notes.\nREADY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: naming nit only",
            })
          },
        }),
      )

      expect(continues).toHaveLength(2)
      expect(continues[0]!.model).toBe("opencode/review-model")
      expect(continues[0]!.variant).toBe("max")
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[0]!.prompt).toBe(buildReviewingPrompt())
      expect(continues[1]!.model).toBe("opencode/build-model")
      expect(continues[1]!.variant).toBe("high")
      expect(continues[1]!.prompt).toContain("REVIEW_FIXED")
      expect(continues[1]!.prompt).toContain("REVIEW_DEFERRED:")
      expect(continues[1]!.prompt).toContain("severity low")
      expect(result).toEqual({
        _tag: "deferred",
        severity: "low",
        reason: "naming nit only",
      })
    }))

  it("returns deferred from the apply path with unresolved severity", () =>
    withTemp(async (root) => {
      let turn = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () => {
            turn += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                turn === 1
                  ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium"
                  : "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: medium: out of scope",
            })
          },
        }),
      )
      expect(result).toEqual({
        _tag: "deferred",
        severity: "medium",
        reason: "out of scope",
      })
    }))

  it("returns cleared from the apply path for low/medium findings", () =>
    withTemp(async (root) => {
      let turn = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () => {
            turn += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                turn === 1
                  ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low"
                  : "READY_FOR_AGENT_RESULT: REVIEW_CLEARED: not a real issue",
            })
          },
        }),
      )
      expect(result).toEqual({
        _tag: "cleared",
        reason: "not a real issue",
      })
    }))

  it("returns Needs Human when apply reports unresolved high", () =>
    withTemp(async (root) => {
      let turn = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () => {
            turn += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                turn === 1
                  ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: high"
                  : "READY_FOR_AGENT_RESULT: REVIEW_UNRESOLVED_HIGH: injection risk remains",
            })
          },
        }),
      )
      expect(result).toEqual({
        _tag: "needs_human",
        reason: "injection risk remains",
      })
      expect(REVIEW_UNRESOLVED_HIGH_REASON).toContain("high-severity")
    }))

  it("returns Needs Human when high findings are deferred without a fix", () =>
    withTemp(async (root) => {
      let turn = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () => {
            turn += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                turn === 1
                  ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: high"
                  : "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: only nits remain",
            })
          },
        }),
      )
      expect(result).toEqual({
        _tag: "needs_human",
        reason: REVIEW_HIGH_UNCHANGED_REASON,
      })
    }))

  it("returns Needs Human when high findings are cleared without a fix", () =>
    withTemp(async (root) => {
      let turn = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: () => {
            turn += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                turn === 1
                  ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: high"
                  : "READY_FOR_AGENT_RESULT: REVIEW_CLEARED: disagree with critic",
            })
          },
        }),
      )
      expect(result).toEqual({
        _tag: "needs_human",
        reason: REVIEW_HIGH_UNCHANGED_REASON,
      })
    }))

  it("runs Pre-Commit then re-reviews after medium FIXED without assessment", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const continues: Array<{
        model: string
        variant: string
        prompt: string
        command?: string
      }> = []

      const result = await run(
        review(
          baseContext(root, {
            model: "opencode/build-model",
            variant: "high",
            reviewModel: "opencode/review-model",
            reviewVariant: "max",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            continues.push({
              model: input.model,
              variant: input.variant,
              prompt: input.prompt,
              command: input.command,
            })
            if (continues.length === 1) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "Found a bug.\nREADY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
              })
            }
            if (continues.length === 2) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "Fixed the bug.\nREADY_FOR_AGENT_RESULT: REVIEW_FIXED",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "Looks good now.\nREADY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            })
          },
        }),
      )

      expect(result).toEqual({ _tag: "clean" })
      expect(continues).toHaveLength(3)
      expect(continues[0]!.model).toBe("opencode/review-model")
      expect(continues[0]!.variant).toBe("max")
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[0]!.prompt).toBe(buildReviewingPrompt())
      expect(continues[1]!.model).toBe("opencode/build-model")
      expect(continues[1]!.variant).toBe("high")
      expect(continues[1]!.prompt).toContain("REVIEW_FIXED")
      expect(continues[2]!.model).toBe("opencode/review-model")
      expect(continues[2]!.variant).toBe("max")
      expect(continues[2]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[2]!.prompt).toBe(buildReviewingPrompt())
      expect(continues.some((turn) => isAssessmentTurn(turn))).toBe(false)
    }))

  it("runs Pre-Commit then full reviewing after high FIXED without assessment", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const continues: Array<{
        model: string
        command?: string
        prompt: string
      }> = []

      const result = await run(
        review(
          baseContext(root, {
            model: "opencode/build-model",
            reviewModel: "opencode/review-model",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            continues.push({
              model: input.model,
              prompt: input.prompt,
              command: input.command,
            })
            if (continues.length === 1) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: high",
              })
            }
            if (continues.length === 2) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            })
          },
        }),
      )

      expect(result).toEqual({ _tag: "clean" })
      expect(continues).toHaveLength(3)
      expect(continues.some((turn) => isAssessmentTurn(turn))).toBe(false)
      expect(continues[2]!.command).toBe(REVIEW_AGENT_COMMAND)
    }))

  it("runs Pre-Commit then re-reviews after high FIXED_AND_DEFERRED without assessment", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const continues: Array<{
        model: string
        command?: string
        prompt: string
      }> = []

      const result = await run(
        review(
          baseContext(root, {
            model: "opencode/build-model",
            reviewModel: "opencode/review-model",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            continues.push({
              model: input.model,
              prompt: input.prompt,
              command: input.command,
            })
            if (continues.length === 1) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: high",
              })
            }
            if (continues.length === 2) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_FIXED_AND_DEFERRED: low: leftover style",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            })
          },
        }),
      )

      expect(result).toEqual({ _tag: "clean" })
      expect(continues).toHaveLength(3)
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[1]!.model).toBe("opencode/build-model")
      expect(continues[1]!.prompt).toContain("REVIEW_FIXED_AND_DEFERRED")
      expect(continues[2]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues.some((turn) => isAssessmentTurn(turn))).toBe(false)
    }))

  it("accepts low-severity FIXED without a second review-model command", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const continues: Array<{
        model: string
        variant: string
        prompt: string
        command?: string
      }> = []

      const result = await run(
        review(
          baseContext(root, {
            model: "opencode/build-model",
            variant: "high",
            reviewModel: "opencode/review-model",
            reviewVariant: "max",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            continues.push({
              model: input.model,
              variant: input.variant,
              prompt: input.prompt,
              command: input.command,
            })
            if (isReviewingTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
              })
            }
            if (isAssessmentTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED: direct localized rename",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            })
          },
        }),
      )

      expect(result).toEqual({
        _tag: "accepted",
        reason: "direct localized rename",
        deferred: null,
      })
      expect(continues).toHaveLength(3)
      expect(continues[0]!.model).toBe("opencode/review-model")
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[1]!.model).toBe("opencode/build-model")
      expect(continues[1]!.prompt).toContain("REVIEW_FIXED")
      expect(continues[2]!.model).toBe("opencode/build-model")
      expect(continues[2]!.variant).toBe("high")
      expect(continues[2]!.command).toBeUndefined()
      expect(continues[2]!.prompt).toBe(buildRerunAssessmentPrompt())
      expect(continues[2]!.prompt).toContain(
        "direct, localized, and semantics-preserving",
      )
      expect(continues.filter((turn) => isReviewingTurn(turn))).toHaveLength(1)
    }))

  it("accepts low FIXED_AND_DEFERRED and preserves deferred severity", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const result = await run(
        review(
          baseContext(root, {
            model: "opencode/build-model",
            reviewModel: "opencode/review-model",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            if (isReviewingTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
              })
            }
            if (isAssessmentTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED: comment-only fix",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_FIXED_AND_DEFERRED: low: leftover import order",
            })
          },
        }),
      )

      expect(result).toEqual({
        _tag: "accepted",
        reason: "comment-only fix",
        deferred: {
          severity: "low",
          reason: "leftover import order",
        },
      })
    }))

  it("re-reviews after low FIXED when assessment requires rerun", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const continues: Array<{
        model: string
        command?: string
        prompt: string
      }> = []

      const result = await run(
        review(
          baseContext(root, {
            model: "opencode/build-model",
            reviewModel: "opencode/review-model",
          }),
        ),
        stubOpencode({
          continue: (input) => {
            continues.push({
              model: input.model,
              prompt: input.prompt,
              command: input.command,
            })
            if (isReviewingTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  continues.filter((turn) => isReviewingTurn(turn)).length === 1
                    ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low"
                    : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
              })
            }
            if (isAssessmentTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: expanded scope into schema",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            })
          },
        }),
      )

      expect(result).toEqual({ _tag: "clean" })
      expect(continues).toHaveLength(4)
      expect(continues[0]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[1]!.model).toBe("opencode/build-model")
      expect(continues[2]!.model).toBe("opencode/build-model")
      expect(isAssessmentTurn(continues[2]!)).toBe(true)
      expect(continues[3]!.command).toBe(REVIEW_AGENT_COMMAND)
      expect(continues[3]!.model).toBe("opencode/review-model")
    }))

  it("falls back to full reviewing when low assessment output is malformed", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const continues: Array<{ prompt: string; command?: string }> = []

      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            continues.push({
              prompt: input.prompt,
              command: input.command,
            })
            if (isReviewingTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  continues.filter((turn) => isReviewingTurn(turn)).length === 1
                    ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low"
                    : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
              })
            }
            if (isAssessmentTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText: "I am unsure and forgot the marker",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            })
          },
        }),
      )

      expect(result).toEqual({ _tag: "clean" })
      expect(continues.filter((turn) => isAssessmentTurn(turn))).toHaveLength(1)
      expect(continues.filter((turn) => isReviewingTurn(turn))).toHaveLength(2)
    }))

  it("fails the Review Step Run when nested Pre-Commit fails after FIXED", () =>
    withTempGit(async (root) => {
      await writeHook(
        root,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "printf '%s\\n' 'format failed permanently' >&2",
          "exit 1",
          "",
        ].join("\n"),
      )
      await writeFile(join(root, "change.txt"), "broken\n")

      let turn = 0
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () => {
            turn += 1
            if (turn <= 2) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  turn === 1
                    ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium"
                    : "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
              })
            }
            return Effect.fail(
              new OpencodeExitError({ exitCode: 2, cwd: root }),
            )
          },
        }),
      )

      expect(error).toBeInstanceOf(PreCommitOpenCodeError)
      expect(turn).toBeGreaterThanOrEqual(3)
    }))

  it("returns Needs Human after MAX_REVIEW_FIX_ROUNDS FIXED rounds without clean or deferred", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "still broken\n")

      let turn = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            turn += 1
            if (isReviewingTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            })
          },
        }),
      )

      // 6 reviewing passes + 5 apply passes (no 6th apply)
      expect(MAX_REVIEW_FIX_ROUNDS).toBe(5)
      expect(turn).toBe(11)
      expect(result).toEqual({
        _tag: "needs_human",
        reason:
          "Review fix limit reached (5); inspect the worktree or address remaining findings, then Retry.",
      })
      expect(REVIEW_FIX_LIMIT_REASON).toBe(
        "Review fix limit reached (5); inspect the worktree or address remaining findings, then Retry.",
      )
    }))

  it("succeeds with clean after fewer than MAX_REVIEW_FIX_ROUNDS FIXED rounds", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      let reviewingPasses = 0
      let applyPasses = 0
      let assessmentPasses = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            if (isReviewingTurn(input)) {
              reviewingPasses += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  reviewingPasses <= 2
                    ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low"
                    : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
              })
            }
            if (isAssessmentTurn(input)) {
              assessmentPasses += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: still uncertain",
              })
            }
            applyPasses += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            })
          },
        }),
      )

      // reviewing, apply, assess, reviewing, apply, assess, reviewing(clean)
      expect(reviewingPasses).toBe(3)
      expect(applyPasses).toBe(2)
      expect(assessmentPasses).toBe(2)
      expect(result).toEqual({ _tag: "clean" })
    }))

  it("succeeds with clean on the reviewing pass after exactly MAX_REVIEW_FIX_ROUNDS FIXED rounds", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      let reviewingPasses = 0
      let applyPasses = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            if (isReviewingTurn(input)) {
              reviewingPasses += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  reviewingPasses <= MAX_REVIEW_FIX_ROUNDS
                    ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium"
                    : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
              })
            }
            applyPasses += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            })
          },
        }),
      )

      expect(MAX_REVIEW_FIX_ROUNDS).toBe(5)
      expect(applyPasses).toBe(5)
      expect(reviewingPasses).toBe(6)
      expect(result).toEqual({ _tag: "clean" })
    }))

  it("succeeds with deferred after fewer than MAX_REVIEW_FIX_ROUNDS FIXED rounds", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      let applyPasses = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            if (isReviewingTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
              })
            }
            if (isAssessmentTurn(input)) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: needs another look",
              })
            }
            applyPasses += 1
            if (applyPasses === 1) {
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
              })
            }
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: remaining style notes",
            })
          },
        }),
      )

      expect(result).toEqual({
        _tag: "deferred",
        severity: "low",
        reason: "remaining style notes",
      })
    }))

  it("counts only changed apply rounds toward the fix limit when assessing low severity", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "still broken\n")

      let reviewingPasses = 0
      let applyPasses = 0
      let assessmentPasses = 0
      const result = await run(
        review(baseContext(root)),
        stubOpencode({
          continue: (input) => {
            if (isReviewingTurn(input)) {
              reviewingPasses += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
              })
            }
            if (isAssessmentTurn(input)) {
              assessmentPasses += 1
              return Effect.succeed({
                sessionId: "ses_implement_session",
                assistantText:
                  "READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: still risky",
              })
            }
            applyPasses += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
            })
          },
        }),
      )

      // 6 reviewing + 5 apply + 5 assessment; no 6th apply
      expect(applyPasses).toBe(5)
      expect(assessmentPasses).toBe(5)
      expect(reviewingPasses).toBe(6)
      expect(result).toEqual({
        _tag: "needs_human",
        reason: REVIEW_FIX_LIMIT_REASON,
      })
    }))

  it("marks Step Run phase as pre-commit during nested Pre-Commit after FIXED", () =>
    withTempGit(async (root) => {
      await writeHook(
        root,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ -f ".pre-commit-fixed" ]; then',
          "  exit 0",
          "fi",
          "printf '%s\\n' 'needs fix' >&2",
          "exit 1",
          "",
        ].join("\n"),
      )
      await writeFile(join(root, "change.txt"), "fixed\n")

      const stepRunId = "srun-01JREVIEWPRECOM000000000001"
      const workItemId = "wi-01JREVIEWPRECOM0000000000001"
      const repositoryId = "repo-review-pre-commit-phase"
      let phaseDuringPreCommit: {
        reason_code: string | null
        reason_message: string | null
      } | null = null

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO repository (
               id, github_owner, github_repo, local_path, is_bare, paused,
               issues_reconciled_at, created_at, updated_at
             ) VALUES (?, 'o', 'r', ?, 1, 0, NULL, ?, ?)`,
            [repositoryId, `/tmp/${repositoryId}`, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO work_item (
               id, repository_id, github_issue_number, model, variant,
               review_model, review_variant, state, state_ready_at, worktree_path,
               session_id, failure_code, failure_message, created_at, updated_at
             ) VALUES (?, ?, 1, 'm', 'v', 'm', 'v', 'review', ?,
               ?, 'ses_implement_session', NULL, NULL, ?, ?)`,
            [workItemId, repositoryId, now, root, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO step_run (
               id, work_item_id, step, status, queue_job_id, queued_at,
               started_at, finished_at, reason_code, reason_message,
               created_at, updated_at
             ) VALUES (?, ?, 'review', 'running', NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
            [stepRunId, workItemId, now, now, now, now],
          )

          let turn = 0
          yield* review(baseContext(root, { repositoryId })).pipe(
            Effect.provideService(CurrentStepRun, {
              stepRunId,
              repositoryId,
            }),
            Effect.provide(
              stubOpencode({
                continue: (input) =>
                  Effect.gen(function* () {
                    turn += 1
                    if (input.prompt.includes("pre-commit")) {
                      const rows = (yield* sql.unsafe(
                        `SELECT reason_code, reason_message FROM step_run WHERE id = ?`,
                        [stepRunId],
                      )) as readonly {
                        readonly reason_code: string | null
                        readonly reason_message: string | null
                      }[]
                      phaseDuringPreCommit = rows[0] ?? null
                      yield* Effect.promise(async () => {
                        await writeFile(join(root, ".pre-commit-fixed"), "ok\n")
                      })
                      return {
                        sessionId: "ses_implement_session",
                        assistantText: "fixed hooks",
                      }
                    }
                    return {
                      sessionId: "ses_implement_session",
                      assistantText:
                        turn === 1
                          ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium"
                          : turn === 2
                            ? "READY_FOR_AGENT_RESULT: REVIEW_FIXED"
                            : "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
                    }
                  }),
              }),
            ),
          )
        }).pipe(
          Effect.provide(DbServiceLive),
          Effect.provide(DatabaseTest),
          Effect.provide(PlatformLayer),
        ),
      )

      expect(phaseDuringPreCommit).toEqual({
        reason_code: STEP_RUN_REASON.reviewPreCommit,
        reason_message: REVIEW_PRE_COMMIT_MESSAGE,
      })
    }))

  it("marks Step Run phase as applying findings during the apply turn", () =>
    withTemp(async (root) => {
      const stepRunId = "srun-01JREVIEWAPPLY000000000001"
      const workItemId = "wi-01JREVIEWAPPLY0000000000001"
      const repositoryId = "repo-review-apply-phase"
      let phaseDuringApply: {
        reason_code: string | null
        reason_message: string | null
      } | null = null

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO repository (
               id, github_owner, github_repo, local_path, is_bare, paused,
               issues_reconciled_at, created_at, updated_at
             ) VALUES (?, 'o', 'r', ?, 1, 0, NULL, ?, ?)`,
            [repositoryId, `/tmp/${repositoryId}`, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO work_item (
               id, repository_id, github_issue_number, model, variant,
               review_model, review_variant, state, state_ready_at, worktree_path,
               session_id, failure_code, failure_message, created_at, updated_at
             ) VALUES (?, ?, 1, 'm', 'v', 'm', 'v', 'review', ?,
               ?, 'ses_implement_session', NULL, NULL, ?, ?)`,
            [workItemId, repositoryId, now, root, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO step_run (
               id, work_item_id, step, status, queue_job_id, queued_at,
               started_at, finished_at, reason_code, reason_message,
               created_at, updated_at
             ) VALUES (?, ?, 'review', 'running', NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
            [stepRunId, workItemId, now, now, now, now],
          )

          let turn = 0
          yield* review(baseContext(root, { repositoryId })).pipe(
            Effect.provideService(CurrentStepRun, {
              stepRunId,
              repositoryId,
            }),
            Effect.provide(
              stubOpencode({
                continue: () =>
                  Effect.gen(function* () {
                    turn += 1
                    if (turn === 2) {
                      const rows = (yield* sql.unsafe(
                        `SELECT reason_code, reason_message FROM step_run WHERE id = ?`,
                        [stepRunId],
                      )) as readonly {
                        readonly reason_code: string | null
                        readonly reason_message: string | null
                      }[]
                      phaseDuringApply = rows[0] ?? null
                    }
                    return {
                      sessionId: "ses_implement_session",
                      assistantText:
                        turn === 1
                          ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low"
                          : "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: low: later",
                    }
                  }),
              }),
            ),
          )
        }).pipe(
          Effect.provide(DbServiceLive),
          Effect.provide(DatabaseTest),
          Effect.provide(PlatformLayer),
        ),
      )

      expect(phaseDuringApply).toEqual({
        reason_code: STEP_RUN_REASON.reviewApplyingFindings,
        reason_message: REVIEW_APPLYING_FINDINGS_MESSAGE,
      })
    }))

  it("marks Step Run phase as assessing rerun during low-severity assessment", () =>
    withTempGit(async (root) => {
      await writeHook(root, "#!/usr/bin/env bash\nexit 0\n")
      await writeFile(join(root, "change.txt"), "fixed\n")

      const stepRunId = "srun-01JREVIEWASSESS000000000001"
      const workItemId = "wi-01JREVIEWASSESS0000000000001"
      const repositoryId = "repo-review-assess-phase"
      let phaseDuringAssess: {
        reason_code: string | null
        reason_message: string | null
      } | null = null

      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO repository (
               id, github_owner, github_repo, local_path, is_bare, paused,
               issues_reconciled_at, created_at, updated_at
             ) VALUES (?, 'o', 'r', ?, 1, 0, NULL, ?, ?)`,
            [repositoryId, `/tmp/${repositoryId}`, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO work_item (
               id, repository_id, github_issue_number, model, variant,
               review_model, review_variant, state, state_ready_at, worktree_path,
               session_id, failure_code, failure_message, created_at, updated_at
             ) VALUES (?, ?, 1, 'm', 'v', 'm', 'v', 'review', ?,
               ?, 'ses_implement_session', NULL, NULL, ?, ?)`,
            [workItemId, repositoryId, now, root, now, now],
          )
          yield* sql.unsafe(
            `INSERT INTO step_run (
               id, work_item_id, step, status, queue_job_id, queued_at,
               started_at, finished_at, reason_code, reason_message,
               created_at, updated_at
             ) VALUES (?, ?, 'review', 'running', NULL, ?, ?, NULL, NULL, NULL, ?, ?)`,
            [stepRunId, workItemId, now, now, now, now],
          )

          yield* review(baseContext(root, { repositoryId })).pipe(
            Effect.provideService(CurrentStepRun, {
              stepRunId,
              repositoryId,
            }),
            Effect.provide(
              stubOpencode({
                continue: (input) =>
                  Effect.gen(function* () {
                    if (isAssessmentTurn(input)) {
                      const rows = (yield* sql.unsafe(
                        `SELECT reason_code, reason_message FROM step_run WHERE id = ?`,
                        [stepRunId],
                      )) as readonly {
                        readonly reason_code: string | null
                        readonly reason_message: string | null
                      }[]
                      phaseDuringAssess = rows[0] ?? null
                      return {
                        sessionId: "ses_implement_session",
                        assistantText:
                          "READY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED: localized only",
                      }
                    }
                    if (isReviewingTurn(input)) {
                      return {
                        sessionId: "ses_implement_session",
                        assistantText:
                          "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
                      }
                    }
                    return {
                      sessionId: "ses_implement_session",
                      assistantText: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
                    }
                  }),
              }),
            ),
          )
        }).pipe(
          Effect.provide(DbServiceLive),
          Effect.provide(DatabaseTest),
          Effect.provide(PlatformLayer),
        ),
      )

      expect(phaseDuringAssess).toEqual({
        reason_code: STEP_RUN_REASON.reviewAssessingRerun,
        reason_message: REVIEW_ASSESSING_RERUN_MESSAGE,
      })
    }))

  it("fails when READY_FOR_AGENT_RESULT is missing on the reviewing pass", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText: "Review complete with no machine line",
            }),
        }),
      )
      expect(error).toBeInstanceOf(ReviewResultError)
    }))

  it("fails when apply-path READY_FOR_AGENT_RESULT is missing or ambiguous", () =>
    withTemp(async (root) => {
      let turn = 0
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () => {
            turn += 1
            return Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                turn === 1
                  ? "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low"
                  : "I fixed things but forgot the marker",
            })
          },
        }),
      )
      expect(error).toBeInstanceOf(ReviewResultError)
      expect((error as ReviewResultError).message).toContain("REVIEW_FIXED")
    }))

  it("fails when READY_FOR_AGENT_RESULT lines are duplicated", () =>
    withTemp(async (root) => {
      let continues = 0
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () => {
            continues += 1
            return continues === 1
              ? Effect.succeed({
                  sessionId: "ses_implement_session",
                  assistantText: [
                    "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
                    "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: low",
                  ].join("\n"),
                })
              : Effect.succeed({
                  sessionId: "ses_implement_session",
                  assistantText: "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
                })
          },
        }),
      )
      expect(error).toBeInstanceOf(ReviewResultError)
      expect(continues).toBe(1)
    }))

  it("fails when READY_FOR_AGENT_RESULT is not the final line", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        stubOpencode({
          continue: () =>
            Effect.succeed({
              sessionId: "ses_implement_session",
              assistantText:
                "READY_FOR_AGENT_RESULT: REVIEW_CLEAN\ntrailing prose",
            }),
        }),
      )
      expect(error).toBeInstanceOf(ReviewResultError)
    }))

  it("maps OpenCode exit failure", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        Layer.succeed(
          Opencode,
          Opencode.of({
            start: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continue: () =>
              Effect.fail(new OpencodeExitError({ exitCode: 2, cwd: root })),
            listModels: () => Effect.succeed([]),
          }),
        ),
      )
      expect(error).toBeInstanceOf(ReviewOpenCodeError)
      expect((error as ReviewOpenCodeError).worktreePath).toBe(root)
    }))

  it("maps OpenCode timeout failure", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        Layer.succeed(
          Opencode,
          Opencode.of({
            start: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continue: () =>
              Effect.fail(
                new OpencodeTimeoutError({ cwd: root, timeoutMs: 1_000 }),
              ),
            listModels: () => Effect.succeed([]),
          }),
        ),
      )
      expect(error).toBeInstanceOf(ReviewOpenCodeError)
    }))

  it("maps missing Session ID from OpenCode", () =>
    withTemp(async (root) => {
      const error = await run(
        review(baseContext(root)).pipe(Effect.flip),
        Layer.succeed(
          Opencode,
          Opencode.of({
            start: () =>
              Effect.succeed({ sessionId: "unused", assistantText: "" }),
            continue: () =>
              Effect.fail(new SessionIdNotFoundError({ cwd: root })),
            listModels: () => Effect.succeed([]),
          }),
        ),
      )
      expect(error).toBeInstanceOf(ReviewOpenCodeError)
    }))
})
