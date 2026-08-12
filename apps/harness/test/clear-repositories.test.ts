import {
  GraphQlRequestError,
  ensureNoConfiguredRepositories,
  liveClearRepositoriesClient,
} from "../e2e/support/clear-repositories.ts"
import { describe, expect, test } from "bun:test"

const recordingClient = (input: {
  readonly lists: ReadonlyArray<ReadonlyArray<string>>
  readonly remove?: (repositoryId: string) => Promise<void>
}) => {
  const removed: string[] = []
  let listIndex = 0
  return {
    removed,
    client: {
      listRepositoryIds: async () => {
        const listed = input.lists[listIndex] ?? input.lists.at(-1) ?? []
        listIndex += 1
        return listed
      },
      removeRepository: async (repositoryId: string) => {
        removed.push(repositoryId)
        if (input.remove !== undefined) {
          await input.remove(repositoryId)
        }
      },
    },
  }
}

const fakeClock = () => {
  let now = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
  }
}

describe("ensureNoConfiguredRepositories", () => {
  test("returns without remove when the Repository list is already empty", async () => {
    const recording = recordingClient({ lists: [[]] })
    const clock = fakeClock()

    await ensureNoConfiguredRepositories({
      client: recording.client,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(recording.removed).toEqual([])
    expect(clock.sleeps).toEqual([])
  })

  test("removes each listed Repository through the client", async () => {
    const recording = recordingClient({
      lists: [["repo-a", "repo-b"], []],
    })

    await ensureNoConfiguredRepositories({
      client: recording.client,
      now: () => 0,
      sleep: async () => {
        throw new Error("should not wait when remove emptied the list")
      },
    })

    expect(recording.removed).toEqual(["repo-a", "repo-b"])
  })

  test("retries when remove is blocked by a running Step Run", async () => {
    let removeAttempts = 0
    const recording = recordingClient({
      lists: [["repo-busy"], ["repo-busy"], []],
      remove: async () => {
        removeAttempts += 1
        if (removeAttempts === 1) {
          throw new GraphQlRequestError(
            [
              "Repository repo-busy has a running Step Run and cannot be removed",
            ],
            ["REPOSITORY_HAS_RUNNING_STEP"],
          )
        }
      },
    })
    const clock = fakeClock()

    await ensureNoConfiguredRepositories({
      client: recording.client,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 2_000,
      retryIntervalMs: 500,
    })

    expect(removeAttempts).toBe(2)
    expect(clock.sleeps).toEqual([500])
  })

  test("retries when remove is blocked by a running Refresh Job", async () => {
    let removeAttempts = 0
    const recording = recordingClient({
      lists: [["repo-refresh"], ["repo-refresh"], []],
      remove: async () => {
        removeAttempts += 1
        if (removeAttempts === 1) {
          throw new GraphQlRequestError(
            ["database is locked"],
            ["DATABASE_ERROR"],
          )
        }
      },
    })
    const clock = fakeClock()

    await ensureNoConfiguredRepositories({
      client: recording.client,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 2_000,
      retryIntervalMs: 500,
    })

    expect(removeAttempts).toBe(2)
    expect(clock.sleeps).toEqual([500])
  })

  test("times out while a Step Run still blocks remove", async () => {
    const recording = recordingClient({
      lists: [["repo-busy"]],
      remove: async () => {
        throw new GraphQlRequestError(
          ["Repository repo-busy has a running Step Run and cannot be removed"],
          ["REPOSITORY_HAS_RUNNING_STEP"],
        )
      },
    })
    const clock = fakeClock()

    await expect(
      ensureNoConfiguredRepositories({
        client: recording.client,
        now: clock.now,
        sleep: clock.sleep,
        timeoutMs: 1_000,
        retryIntervalMs: 500,
      }),
    ).rejects.toThrow(/Step Run is still running/)
  })

  test("times out while a Refresh Job still blocks remove", async () => {
    const recording = recordingClient({
      lists: [["repo-refresh"]],
      remove: async () => {
        throw new Error(
          "database is locked while a Refresh Job is writing the Issue store",
        )
      },
    })
    const clock = fakeClock()

    await expect(
      ensureNoConfiguredRepositories({
        client: recording.client,
        now: clock.now,
        sleep: clock.sleep,
        timeoutMs: 1_000,
        retryIntervalMs: 500,
      }),
    ).rejects.toThrow(/Refresh Job/)
  })

  test("throws a non-retryable remove error immediately", async () => {
    const recording = recordingClient({
      lists: [["repo-bad"]],
      remove: async () => {
        throw new GraphQlRequestError(
          ["Repository not found: repo-bad"],
          ["REPOSITORY_NOT_FOUND"],
        )
      },
    })

    await expect(
      ensureNoConfiguredRepositories({
        client: recording.client,
        now: () => 0,
        sleep: async () => {
          throw new Error("should not retry a permanent remove failure")
        },
      }),
    ).rejects.toThrow(/Repository not found: repo-bad/)
  })

  test("throws a permanent DATABASE_ERROR immediately", async () => {
    const recording = recordingClient({
      lists: [["repo-constraint"]],
      remove: async () => {
        throw new GraphQlRequestError(
          ["FOREIGN KEY constraint failed"],
          ["DATABASE_ERROR"],
        )
      },
    })

    await expect(
      ensureNoConfiguredRepositories({
        client: recording.client,
        now: () => 0,
        sleep: async () => {
          throw new Error("should not retry a permanent database error")
        },
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})

describe("liveClearRepositoriesClient", () => {
  test("lists and removes Repositories through GraphQL documents", async () => {
    const queries: Array<{
      readonly query: string
      readonly variables?: Record<string, unknown>
    }> = []
    const graphql = async <T>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> => {
      queries.push({ query, variables })
      if (query.includes("removeRepository")) {
        return { removeRepository: variables?.repositoryId } as T
      }
      return { repositories: [{ id: "repo-1" }] } as T
    }
    const client = liveClearRepositoriesClient(graphql)

    expect(await client.listRepositoryIds()).toEqual(["repo-1"])
    await client.removeRepository("repo-1")

    expect(queries[0]?.query).toMatch(
      /query\s*\{\s*repositories\s*\{\s*id\s*\}/,
    )
    expect(queries[1]?.query).toContain("removeRepository")
    expect(queries[1]?.variables).toEqual({ repositoryId: "repo-1" })
  })
})
