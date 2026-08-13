import {
  parseRepositoryIdentityArgument,
  resolveRepositoryIdentity,
} from "./repository-identity.ts"
import { describe, expect, test } from "bun:test"

const githubReadyForAgent = {
  id: "repo-github-rfa",
  forgeHost: "github.com",
  projectPath: "berenddeboer/ready-for-agent",
}

const gitlabOauthClient = {
  id: "repo-gitlab-oauth",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
}

const gitlabNested = {
  id: "repo-gitlab-nested",
  forgeHost: "gitlab.example.com",
  projectPath: "group/subgroup/project",
}

const acmeHostWidgets = {
  id: "repo-acme-host",
  forgeHost: "acme",
  projectPath: "widgets",
}

const githubAcmeWidgets = {
  id: "repo-github-acme-widgets",
  forgeHost: "github.com",
  projectPath: "acme/widgets",
}

describe("repository identity parsing", () => {
  test("parses explicit host://project-path including nested GitLab paths", () => {
    expect(
      parseRepositoryIdentityArgument(
        "github.com://berenddeboer/ready-for-agent",
      ),
    ).toEqual({
      _tag: "explicit_host_path",
      selector: "github.com://berenddeboer/ready-for-agent",
      forgeHost: "github.com",
      projectPath: "berenddeboer/ready-for-agent",
    })
    expect(
      parseRepositoryIdentityArgument(
        "git.drupalcode.org://group/subgroup/project",
      ),
    ).toEqual({
      _tag: "explicit_host_path",
      selector: "git.drupalcode.org://group/subgroup/project",
      forgeHost: "git.drupalcode.org",
      projectPath: "group/subgroup/project",
    })
  })

  test("parses forge-host/project-path including nested GitLab paths", () => {
    expect(parseRepositoryIdentityArgument("github.com/owner/repo")).toEqual({
      _tag: "host_or_project_path",
      selector: "github.com/owner/repo",
      forgeHost: "github.com",
      projectPath: "owner/repo",
    })
    expect(
      parseRepositoryIdentityArgument(
        "git.drupalcode.org/project/oauth_client",
      ),
    ).toEqual({
      _tag: "host_or_project_path",
      selector: "git.drupalcode.org/project/oauth_client",
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
    })
  })

  test("parses a project-name selector for values without a slash", () => {
    expect(parseRepositoryIdentityArgument("ready-for-agent")).toEqual({
      _tag: "project_name",
      selector: "ready-for-agent",
      projectName: "ready-for-agent",
    })
    expect(parseRepositoryIdentityArgument("repo-01ABC")).toEqual({
      _tag: "project_name",
      selector: "repo-01ABC",
      projectName: "repo-01ABC",
    })
  })

  test("rejects structurally empty, leading or trailing slash, and URL schemes", () => {
    expect(parseRepositoryIdentityArgument("")).toEqual({
      _tag: "invalid",
      argument: "",
    })
    expect(parseRepositoryIdentityArgument("   ")).toEqual({
      _tag: "invalid",
      argument: "   ",
    })
    expect(parseRepositoryIdentityArgument("/owner/repo")).toEqual({
      _tag: "invalid",
      argument: "/owner/repo",
    })
    expect(parseRepositoryIdentityArgument("github.com/")).toEqual({
      _tag: "invalid",
      argument: "github.com/",
    })
    expect(parseRepositoryIdentityArgument("owner/repo/")).toEqual({
      _tag: "invalid",
      argument: "owner/repo/",
    })
    expect(parseRepositoryIdentityArgument("github.com://")).toEqual({
      _tag: "invalid",
      argument: "github.com://",
    })
    expect(parseRepositoryIdentityArgument("://owner/repo")).toEqual({
      _tag: "invalid",
      argument: "://owner/repo",
    })
    expect(parseRepositoryIdentityArgument("github.com://owner/repo/")).toEqual(
      {
        _tag: "invalid",
        argument: "github.com://owner/repo/",
      },
    )
    expect(
      parseRepositoryIdentityArgument("https://github.com/owner/repo"),
    ).toEqual({
      _tag: "invalid",
      argument: "https://github.com/owner/repo",
    })
    expect(
      parseRepositoryIdentityArgument("HTTP://github.com/owner/repo"),
    ).toEqual({
      _tag: "invalid",
      argument: "HTTP://github.com/owner/repo",
    })
    expect(
      parseRepositoryIdentityArgument("ssh://git@github.com/owner/repo.git"),
    ).toEqual({
      _tag: "invalid",
      argument: "ssh://git@github.com/owner/repo.git",
    })
    expect(
      parseRepositoryIdentityArgument("git://github.com/owner/repo.git"),
    ).toEqual({
      _tag: "invalid",
      argument: "git://github.com/owner/repo.git",
    })
  })
})

describe("repository identity resolution", () => {
  test("matches an explicit host://project-path selector without falling through", () => {
    const repositories = [githubReadyForAgent, gitlabOauthClient]
    expect(
      resolveRepositoryIdentity(
        "github.com://berenddeboer/ready-for-agent",
        repositories,
      ),
    ).toEqual({
      _tag: "matched",
      repository: githubReadyForAgent,
    })
    expect(
      resolveRepositoryIdentity(
        "missing.example://berenddeboer/ready-for-agent",
        repositories,
      ),
    ).toEqual({
      _tag: "not_found",
      selector: "missing.example://berenddeboer/ready-for-agent",
    })
  })

  test("matches the legacy host/project-path selector case-insensitively", () => {
    const repositories = [
      {
        id: "repo-1",
        forgeHost: "github.com",
        projectPath: "Owner/Repo",
      },
      gitlabOauthClient,
    ]
    expect(
      resolveRepositoryIdentity("GitHub.com/owner/repo", repositories),
    ).toEqual({
      _tag: "matched",
      repository: repositories[0],
    })
    expect(
      resolveRepositoryIdentity("github.com/missing/repo", repositories),
    ).toEqual({
      _tag: "not_found",
      selector: "github.com/missing/repo",
    })
  })

  test("matches a unique full project path when host/path has no match", () => {
    const repositories = [githubReadyForAgent, gitlabNested]
    expect(
      resolveRepositoryIdentity("berenddeboer/ready-for-agent", repositories),
    ).toEqual({
      _tag: "matched",
      repository: githubReadyForAgent,
    })
    expect(
      resolveRepositoryIdentity("group/subgroup/project", repositories),
    ).toEqual({
      _tag: "matched",
      repository: gitlabNested,
    })
  })

  test("matches a unique final project-path segment", () => {
    const repositories = [githubReadyForAgent, gitlabOauthClient, gitlabNested]
    expect(resolveRepositoryIdentity("ready-for-agent", repositories)).toEqual({
      _tag: "matched",
      repository: githubReadyForAgent,
    })
    expect(resolveRepositoryIdentity("oauth_client", repositories)).toEqual({
      _tag: "matched",
      repository: gitlabOauthClient,
    })
    expect(resolveRepositoryIdentity("project", repositories)).toEqual({
      _tag: "matched",
      repository: gitlabNested,
    })
    expect(resolveRepositoryIdentity("repo-01ABC", repositories)).toEqual({
      _tag: "not_found",
      selector: "repo-01ABC",
    })
  })

  test("matches selectors case-insensitively and preserves configured casing", () => {
    const repositories = [githubReadyForAgent]
    expect(
      resolveRepositoryIdentity(
        "GitHub.COM://BerendDeBoer/Ready-For-Agent",
        repositories,
      ),
    ).toEqual({
      _tag: "matched",
      repository: githubReadyForAgent,
    })
    expect(
      resolveRepositoryIdentity("BERENDDEBOER/READY-FOR-AGENT", repositories),
    ).toEqual({
      _tag: "matched",
      repository: githubReadyForAgent,
    })
    expect(resolveRepositoryIdentity("Ready-For-Agent", repositories)).toEqual({
      _tag: "matched",
      repository: githubReadyForAgent,
    })
  })

  test("prefers an exact host-plus-path match over a project-path shorthand", () => {
    const repositories = [acmeHostWidgets, githubAcmeWidgets]
    expect(resolveRepositoryIdentity("acme/widgets", repositories)).toEqual({
      _tag: "matched",
      repository: acmeHostWidgets,
    })
    expect(
      resolveRepositoryIdentity("github.com://acme/widgets", repositories),
    ).toEqual({
      _tag: "matched",
      repository: githubAcmeWidgets,
    })
  })

  test("reports ambiguous project paths across Forge Hosts in deterministic order", () => {
    const gitlabReadyForAgent = {
      id: "repo-gitlab-rfa",
      forgeHost: "gitlab.com",
      projectPath: "berenddeboer/ready-for-agent",
    }
    const repositories = [gitlabReadyForAgent, githubReadyForAgent]
    expect(
      resolveRepositoryIdentity("berenddeboer/ready-for-agent", repositories),
    ).toEqual({
      _tag: "ambiguous",
      selector: "berenddeboer/ready-for-agent",
      matches: [githubReadyForAgent, gitlabReadyForAgent],
    })
  })

  test("reports ambiguous final segments across owners in deterministic order", () => {
    const otherReadyForAgent = {
      id: "repo-other-rfa",
      forgeHost: "github.com",
      projectPath: "acme/ready-for-agent",
    }
    const repositories = [otherReadyForAgent, githubReadyForAgent]
    expect(resolveRepositoryIdentity("ready-for-agent", repositories)).toEqual({
      _tag: "ambiguous",
      selector: "ready-for-agent",
      matches: [otherReadyForAgent, githubReadyForAgent],
    })
  })

  test("reports ambiguous exact host-plus-path matches in deterministic order", () => {
    const repositories = [
      {
        id: "repo-2",
        forgeHost: "GitHub.com",
        projectPath: "Owner/Repo",
      },
      {
        id: "repo-1",
        forgeHost: "github.com",
        projectPath: "owner/repo",
      },
    ]
    expect(
      resolveRepositoryIdentity("github.com/owner/repo", repositories),
    ).toEqual({
      _tag: "ambiguous",
      selector: "github.com/owner/repo",
      matches: [repositories[1], repositories[0]],
    })
  })

  test("keeps a missing explicit host://path as not found instead of shorthand", () => {
    expect(
      resolveRepositoryIdentity("github.com://acme/widgets", [acmeHostWidgets]),
    ).toEqual({
      _tag: "not_found",
      selector: "github.com://acme/widgets",
    })
  })

  test("returns invalid for malformed selectors and disallowed URL schemes", () => {
    expect(resolveRepositoryIdentity("", [])).toEqual({
      _tag: "invalid",
      argument: "",
    })
    expect(resolveRepositoryIdentity("/owner/repo", [])).toEqual({
      _tag: "invalid",
      argument: "/owner/repo",
    })
    expect(
      resolveRepositoryIdentity("https://github.com/owner/repo", []),
    ).toEqual({
      _tag: "invalid",
      argument: "https://github.com/owner/repo",
    })
  })
})
