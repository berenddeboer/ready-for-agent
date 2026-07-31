import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "@playwright/test"
import {
  type FixtureForge,
  cloneFixtureRepository,
  gitlabFixtureSpec,
  hasFixtureCredential,
} from "../support/clone-fixture-repo.ts"
import {
  E2E_GRAPHQL_URL,
  FIXTURE_GITHUB_REPOSITORY,
  FIXTURE_GITLAB_PROJECT_PATH,
  GITHUB_SENTINEL_ISSUE_NUMBER,
  GITHUB_SENTINEL_ISSUE_TITLE,
  GITLAB_SENTINEL_ISSUE_TITLE,
  SCENARIO_TIMEOUT_MS,
  SENTINEL_EXPECT_TIMEOUT_MS,
  gitlabSentinelIssueNumber,
} from "../support/constants.ts"
import { Given, Then, When, test } from "./fixtures.ts"

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
)

const displayRepositoryFor = (forge: FixtureForge): string =>
  forge === "gitlab" ? FIXTURE_GITLAB_PROJECT_PATH : FIXTURE_GITHUB_REPOSITORY

const sentinelFor = (forge: FixtureForge) =>
  forge === "gitlab"
    ? {
        number: gitlabSentinelIssueNumber(),
        title: GITLAB_SENTINEL_ISSUE_TITLE,
      }
    : {
        number: GITHUB_SENTINEL_ISSUE_NUMBER,
        title: GITHUB_SENTINEL_ISSUE_TITLE,
      }

class GraphQlRequestError extends Error {
  readonly codes: ReadonlyArray<string>

  constructor(messages: ReadonlyArray<string>, codes: ReadonlyArray<string>) {
    super(`GraphQL errors: ${messages.join("; ")}`)
    this.name = "GraphQlRequestError"
    this.codes = codes
  }
}

const graphqlRequest = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(E2E_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as {
    data?: T
    errors?: ReadonlyArray<{
      message: string
      extensions?: { code?: string }
    }>
  }
  if (payload.errors?.length) {
    throw new GraphQlRequestError(
      payload.errors.map((e) => e.message),
      payload.errors.map((e) => e.extensions?.code ?? ""),
    )
  }
  if (!payload.data) {
    throw new Error("GraphQL response missing data")
  }
  return payload.data
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isRunningStepRemoveError = (error: unknown): boolean => {
  if (error instanceof GraphQlRequestError) {
    if (error.codes.includes("REPOSITORY_HAS_RUNNING_STEP")) {
      return true
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return (
    /REPOSITORY_HAS_RUNNING_STEP/i.test(message) ||
    /has a running Step Run/i.test(message) ||
    /RepositoryHasRunningStep/i.test(message)
  )
}

/**
 * Clear leftover Repositories so multi-scenario e2e shares one Harness process.
 * Retries briefly when remove is blocked by a still-running Step Run.
 */
const ensureNoConfiguredRepositories = async () => {
  const deadline = Date.now() + 30_000
  let attempt = 0
  while (true) {
    attempt += 1
    const listed = await graphqlRequest<{
      repositories: ReadonlyArray<{ id: string }>
    }>(`query { repositories { id } }`)
    if (listed.repositories.length === 0) {
      return
    }

    let blockedByRunningStep = false
    const failures: string[] = []
    for (const repository of listed.repositories) {
      try {
        await graphqlRequest(
          `mutation RemoveRepository($repositoryId: ID!) {
            removeRepository(repositoryId: $repositoryId)
          }`,
          { repositoryId: repository.id },
        )
      } catch (error) {
        if (isRunningStepRemoveError(error)) {
          blockedByRunningStep = true
          failures.push(error instanceof Error ? error.message : String(error))
          continue
        }
        throw error
      }
    }

    // When no remove was classified as running-step blocked, re-list and return
    // only if empty; otherwise retry until the deadline (blocked path re-lists
    // at the top of the next loop iteration).
    if (!blockedByRunningStep) {
      const remaining = await graphqlRequest<{
        repositories: ReadonlyArray<{ id: string }>
      }>(`query { repositories { id } }`)
      if (remaining.repositories.length === 0) {
        return
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        [
          "Could not clear configured Repositories",
          blockedByRunningStep
            ? "because a Step Run is still running"
            : "after remove mutations",
          `(after ${attempt} attempts over ~30s).`,
          "Multi-scenario e2e shares one Harness process; wait for refresh/work",
          "to finish, or restart the e2e webServer.",
          ...failures,
        ].join(" "),
      )
    }
    await sleep(500)
  }
}

Given("the Harness has no configured Repositories", async ({ page }) => {
  test.setTimeout(SCENARIO_TIMEOUT_MS)
  await ensureNoConfiguredRepositories()
  // Zero repos: home shows the add-repo blank slate (not an empty kanban board).
  await page.goto("/")
  await expect(
    page.getByRole("heading", { name: "No repositories configured" }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Add a repository" }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Lifecycle pipeline" }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Committed pull requests" }),
  ).toHaveCount(0)
  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Repos" }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toHaveCount(0)

  await page.goto("/repos")
  await expect(
    page.getByRole("heading", { name: "No repositories configured" }),
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Add a repository" }),
  ).toBeVisible()
})

Given("the End-to-End Fixture Repository is checked out", async ({ world }) => {
  const { checkoutPath, cleanup, spec } = await cloneFixtureRepository("github")
  world.fixtureCheckoutPath = checkoutPath
  world.cleanupFixtureCheckout = cleanup
  world.fixtureForge = "github"
  world.fixtureDisplayRepository = spec.displayRepository
})

Given(
  "the GitLab End-to-End Fixture Repository is checked out",
  async ({ world }) => {
    const spec = gitlabFixtureSpec()
    // Soft-skip until the dual-secret fixture vault is regenerated (operator
    // step after the throwaway project and PAT exist). Hard-require with
    // E2E_REQUIRE_GITLAB=1 so CI can fail closed once the vault includes
    // the GitLab credential. Infrastructure errors (missing master key,
    // keymaxxer list failure) always throw rather than soft-skipping.
    let hasCredential: boolean
    try {
      hasCredential = hasFixtureCredential(spec)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        [
          "Could not inspect the Keymaxxer vault for the GitLab e2e credential.",
          detail,
        ].join(" "),
      )
    }
    if (!hasCredential) {
      const requireGitlab =
        process.env.E2E_REQUIRE_GITLAB === "1" ||
        process.env.E2E_REQUIRE_GITLAB === "true"
      const message = [
        "GitLab e2e credential is not present in the Keymaxxer vault.",
        `Expected secret ${spec.secretName} (provider=gitlab account=${spec.account}).`,
        "Create the throwaway fixture on git.drupalcode.org, mint a PAT, and run",
        "./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab",
        "(see docs/e2e-fixture.md).",
        "Set E2E_REQUIRE_GITLAB=1 to fail instead of skipping.",
      ].join(" ")
      if (requireGitlab) {
        throw new Error(message)
      }
      test.skip(true, message)
      return
    }

    const {
      checkoutPath,
      cleanup,
      spec: cloneSpec,
    } = await cloneFixtureRepository("gitlab")
    world.fixtureCheckoutPath = checkoutPath
    world.cleanupFixtureCheckout = cleanup
    world.fixtureForge = "gitlab"
    world.fixtureDisplayRepository = cloneSpec.displayRepository
  },
)

When("I add the Repository with the CLI", async ({ world }) => {
  const checkoutPath = world.fixtureCheckoutPath
  if (!checkoutPath) {
    throw new Error("Fixture checkout path is missing from the scenario world")
  }

  const result = spawnSync(
    "bun",
    ["run", "ready-for-agent", "add", checkoutPath],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        READY_FOR_AGENT_GRAPHQL_URL: E2E_GRAPHQL_URL,
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  )

  if (result.status !== 0) {
    throw new Error(
      [
        "CLI failed to add the End-to-End Fixture Repository.",
        result.stderr?.trim() ||
          result.stdout?.trim() ||
          `exit ${result.status}`,
      ].join("\n"),
    )
  }
})

Then("the Repository appears in the Harness", async ({ page, world }) => {
  const forge = world.fixtureForge ?? "github"
  const display = world.fixtureDisplayRepository ?? displayRepositoryFor(forge)

  await page.goto("/repos")
  await expect(
    page.getByRole("region", { name: "Configured repositories" }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("link", { name: display })).toBeVisible()
})

Then(
  "the sentinel Issue appears after the automatic first Refresh Job",
  async ({ page, world }) => {
    const forge = world.fixtureForge ?? "github"
    const sentinel = sentinelFor(forge)
    // Tolerate unrelated Issues; only require the permanent sentinel identity.
    await expect(
      page.getByText(`#${sentinel.number}`, { exact: true }),
    ).toBeVisible({
      timeout: SENTINEL_EXPECT_TIMEOUT_MS,
    })
    await expect(page.getByRole("link", { name: sentinel.title })).toBeVisible({
      timeout: SENTINEL_EXPECT_TIMEOUT_MS,
    })
  },
)
