import { type Route, expect, test } from "@playwright/test"

const repositoryId = "repo-01JSELECTED000000000000000"

const repository = (issuesReconciledAt: string | null) => ({
  id: repositoryId,
  githubOwner: "acme",
  githubRepo: "widgets",
  localPath: "/repos/acme/widgets",
  isBare: true,
  paused: true,
  issuesReconciledAt,
})

const issue = {
  id: "issue-01JAFTER00000000000000000",
  githubIssueNumber: 59,
  title: "Asynchronously refreshed Issue",
  url: "https://github.com/acme/widgets/issues/59",
  state: "OPEN",
  parent: null,
  hasChildren: false,
  blockedBy: [],
}

test("Refresh returns after enqueueing and updates after worker invalidation", async ({
  page,
}) => {
  let workerCompleted = false
  let releaseInvalidation: (() => void) | undefined
  const invalidation = new Promise<void>((resolve) => {
    releaseInvalidation = resolve
  })

  const jsonResponse = (query: string) => {
    if (query.includes("refreshRepository")) {
      return {
        data: {
          refreshRepository: {
            id: "qjob-01JENQUEUED00000000000000",
            repositoryId,
          },
        },
      }
    }
    if (query.includes("repositoryCredentials")) {
      return {
        data: {
          repositories: [
            repository(workerCompleted ? "2026-07-14T12:00:00.000Z" : null),
          ],
          repositoryCredentials: [
            {
              repositoryId,
              configured: true,
              githubTokenSecretName: "GITHUB_TOKEN_ACME_WIDGETS",
              githubTokenCreationUrl: "https://github.com/settings/tokens",
            },
          ],
        },
      }
    }
    if (query.includes("issues(")) {
      return { data: { issues: workerCompleted ? [issue] : [] } }
    }
    if (query.includes("config")) {
      return {
        data: { config: { defaultModel: "test/model", defaultVariant: "low" } },
      }
    }
    if (query.includes("models")) {
      return { data: { models: ["test/model"] } }
    }
    throw new Error(`Unexpected GraphQL operation: ${query}`)
  }

  const fulfillJson = async (route: Route, body: unknown) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    })

  await page.route("**/graphql", async (route) => {
    const request = route.request()
    const operation = request.postDataJSON() as
      | { query: string }
      | readonly { query: string }[]
    const operations = Array.isArray(operation) ? operation : [operation]

    if (operations[0]?.query.includes("repositoryIssuesChanged")) {
      await invalidation
      await route.fulfill({
        contentType: "text/event-stream",
        body: `event: next\ndata: {"data":{"repositoryIssuesChanged":"${repositoryId}"}}\n\nevent: complete\n\n`,
      })
      return
    }
    if (operations[0]?.query.includes("repositoriesChanged")) {
      await route.fulfill({
        contentType: "text/event-stream",
        body: "event: complete\n\n",
      })
      return
    }

    const responses = operations.map(({ query }) => jsonResponse(query))
    await fulfillJson(
      route,
      Array.isArray(operation) ? responses : responses[0],
    )
  })

  await page.goto("/")
  await expect(page.getByText("Not refreshed yet.")).toBeVisible()

  const refresh = page.getByRole("button", { name: "Refresh issues" })
  await refresh.click()

  // Mutation acceptance ends the pending state while the controlled worker
  // remains incomplete and the old reconciliation metadata is still shown.
  await expect(refresh).toBeEnabled()
  await expect(page.getByText("Not refreshed yet.")).toBeVisible()

  workerCompleted = true
  releaseInvalidation?.()

  await expect(page.getByText("Asynchronously refreshed Issue")).toBeVisible()
  await expect(page.getByText("Not refreshed yet.")).not.toBeVisible()
})
