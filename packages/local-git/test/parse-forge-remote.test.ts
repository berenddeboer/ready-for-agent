import { Option } from "effect"
import { parseForgeRemote } from "../src/lib/parse-forge-remote.js"
import { describe, expect, test } from "bun:test"

const expectRemote = (
  url: string,
  expected: {
    readonly forge: "github" | "gitlab" | "azure-devops"
    readonly forgeHost: string
    readonly projectPath: string
  },
): void => {
  const result = parseForgeRemote(url)
  expect(Option.isSome(result)).toBe(true)
  if (Option.isSome(result)) {
    expect(result.value).toEqual(expected)
  }
}

describe("parseForgeRemote", () => {
  test("recognizes GitHub spellings", () => {
    expectRemote("git@github.com:owner/repo.git", {
      forge: "github",
      forgeHost: "github.com",
      projectPath: "owner/repo",
    })
    expectRemote("https://github.com/owner/repo", {
      forge: "github",
      forgeHost: "github.com",
      projectPath: "owner/repo",
    })
  })

  test("recognizes GitLab nested project paths", () => {
    expectRemote("git@gitlab.example:group/nested/project.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/nested/project",
    })
    expectRemote("https://gitlab.example/group/nested/project.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/nested/project",
    })
    expectRemote("ssh://git@gitlab.example/group/nested/project.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/nested/project",
    })
  })

  test("treats non-GitHub network hosts as correctable GitLab guesses", () => {
    expectRemote("git@bitbucket.org:owner/repo.git", {
      forge: "gitlab",
      forgeHost: "bitbucket.org",
      projectPath: "owner/repo",
    })
  })

  test("keeps non-default HTTPS ports in the Forge Host guess", () => {
    expectRemote("https://gitlab.example.com:8443/group/app.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example.com:8443",
      projectPath: "group/app",
    })
    expectRemote("http://gitlab.internal:8080/group/app", {
      forge: "gitlab",
      forgeHost: "gitlab.internal:8080",
      projectPath: "group/app",
    })
  })

  test("does not treat SSH URL ports as the API Forge Host port", () => {
    expectRemote("ssh://git@gitlab.example.com:2222/group/app.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example.com",
      projectPath: "group/app",
    })
  })

  test("rejects local and malformed remotes", () => {
    expect(Option.isNone(parseForgeRemote("../owner/repo.git"))).toBe(true)
    expect(Option.isNone(parseForgeRemote("not-a-url"))).toBe(true)
  })

  test("recognizes dev.azure.com HTTPS and SSH remotes", () => {
    expectRemote("https://dev.azure.com/acme/widgets/_git/widgets", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
    // Org-as-userinfo spelling some clients emit.
    expectRemote("https://acme@dev.azure.com/acme/widgets/_git/widgets", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
    expectRemote("git@ssh.dev.azure.com:v3/acme/widgets/widgets", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
  })

  test("recognizes legacy *.visualstudio.com remotes and canonicalizes the Forge Host", () => {
    expectRemote("https://acme.visualstudio.com/widgets/_git/widgets", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
    expectRemote(
      "https://acme.visualstudio.com/DefaultCollection/widgets/_git/widgets",
      {
        forge: "azure-devops",
        forgeHost: "dev.azure.com",
        projectPath: "acme/widgets",
      },
    )
    // Legacy SSH host: org comes from the v3 path, not the hostname.
    expectRemote("git@vs-ssh.visualstudio.com:v3/acme/Default/gantry", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/Default/gantry",
    })
    expectRemote("git@vs-ssh.visualstudio.com:v3/acme/widgets/widgets", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
  })

  test("does not misclassify an Azure DevOps host missing the _git path segment", () => {
    // Falls through to the GitLab catch-all rather than Azure DevOps —
    // matches "matched before the GitLab catch-all" without inventing an
    // org/project split for an unrecognized dev.azure.com path shape.
    expectRemote("https://dev.azure.com/acme/widgets", {
      forge: "gitlab",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
  })

  test("folds a distinct Git repository name into a third Project Path segment", () => {
    // A project ("Default") containing a differently-named Git repository
    // ("gantry") — the real-world pattern from issue #15. All three clone
    // URL spellings must capture `gantry`, not silently assume it equals
    // the project name.
    expectRemote("https://dev.azure.com/MSD-Production/Default/_git/gantry", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "MSD-Production/Default/gantry",
    })
    expectRemote("git@ssh.dev.azure.com:v3/MSD-Production/Default/gantry", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "MSD-Production/Default/gantry",
    })
    expectRemote("https://acme.visualstudio.com/Default/_git/gantry", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/Default/gantry",
    })
    expectRemote(
      "https://acme.visualstudio.com/DefaultCollection/Default/_git/gantry",
      {
        forge: "azure-devops",
        forgeHost: "dev.azure.com",
        projectPath: "acme/Default/gantry",
      },
    )
  })

  test("keeps the two-segment Project Path when the repo name matches the project name (unchanged common case)", () => {
    expectRemote("https://dev.azure.com/acme/widgets/_git/widgets", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/widgets",
    })
  })

  test("decodes percent-encoded URL remotes exactly once", () => {
    // URL.pathname preserves percent-encoding; Forge API and clone URL
    // builders re-encode each segment, so escapes must be decoded here or
    // names with spaces double-encode (`%2520`). SCP spellings carry raw
    // names and are unaffected.
    expectRemote("https://dev.azure.com/acme/My%20Project/_git/My%20Repo", {
      forge: "azure-devops",
      forgeHost: "dev.azure.com",
      projectPath: "acme/My Project/My Repo",
    })
    expectRemote("https://gitlab.example/group/my%20app.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/my app",
    })
    // Malformed escapes stay as-is rather than throwing.
    expectRemote("https://gitlab.example/group/app%ZZ.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/app%ZZ",
    })
  })
})
