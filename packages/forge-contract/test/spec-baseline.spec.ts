import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  renderSpecBaseline,
  resolveSpecBaseline,
} from "../src/lib/spec-baseline.js"
import { renderSpecRequirementChecklist } from "../src/lib/spec-requirement-checklist.js"
import { expect, test } from "bun:test"

const approved = "Expose MCP in both local and deployed environments."
const localSlice = "Expose MCP locally. Deployment is outside this PR's scope."
const parent = {
  marked: true,
  title: "Hosted MCP",
  body: localSlice,
  url: "https://github.com/acme/widgets/issues/4",
}
const oldLink = `https://github.com/acme/widgets/blob/${"a".repeat(40)}/design.md`
const conflictingLink = `https://github.com/acme/widgets/blob/${"b".repeat(40)}/design.md`
const mutableLink = "https://github.com/acme/widgets/blob/main/design.md"
const source = `${parent.url}#issuecomment-1`
const approvalLink = (url: string) => `[Approved Spec baseline](<${url}>)`
const cite = (body: string, ...urls: string[]) =>
  [body, ...urls.map(approvalLink)].join("\n\n")

test("only one explicitly cited, unedited checklist for the selected publication is authoritative", () => {
  const checklistUrl = `${parent.url}#issuecomment-checklist`
  const citation = `[Approved requirement checklist](<${checklistUrl}>)`
  const requirements = [
    { id: "mcp-local", requirement: "Local MCP works", environment: "local" },
    {
      id: "mcp-deployed",
      requirement: "Deployed MCP works",
      environment: "deployed",
    },
  ]
  const snapshot = {
    url: source,
    edited: false,
    body: renderSpecBaseline({
      title: parent.title,
      body: approved,
      designRevisions: [],
    }),
  }
  const checklist = {
    url: checklistUrl,
    edited: false,
    body: renderSpecRequirementChecklist({ baselineUrl: source, requirements }),
  }
  const resolve = (extra: string, comment = checklist) => {
    const result = resolveSpecBaseline(
      { ...parent, body: `${cite(parent.body, source)}\n\n${extra}` },
      [snapshot, comment],
    )
    expect(result.kind).toBe("baseline")
    return result.kind === "baseline"
      ? result.baseline.requirementChecklist
      : undefined
  }
  expect(resolve(citation)).toEqual({
    baselineUrl: source,
    sourceUrl: checklistUrl,
    requirements,
  })
  expect(resolve("")).toBeUndefined()
  expect(resolve(`> ${citation}`)).toBeUndefined()
  expect(resolve(`\`\`\`\n${citation}\n\`\`\``)).toBeUndefined()
  expect(
    resolve(
      `${citation}\n[Approved requirement checklist](<${parent.url}#other>)`,
    ),
  ).toBeUndefined()
  expect(resolve(citation, { ...checklist, edited: true })).toBeUndefined()
  expect(
    resolve(citation, {
      ...checklist,
      body: renderSpecRequirementChecklist({
        baselineUrl: `${parent.url}#other-baseline`,
        requirements,
      }),
    }),
  ).toBeUndefined()
  const competingSource = `${parent.url}#issuecomment-other-snapshot`
  const conflict = resolveSpecBaseline(
    {
      ...parent,
      body: `${cite(parent.body, source, competingSource)}\n\n${citation}`,
    },
    [
      snapshot,
      {
        url: competingSource,
        edited: false,
        body: renderSpecBaseline({
          title: parent.title,
          body: localSlice,
          designRevisions: [],
        }),
      },
      checklist,
    ],
  )
  expect(conflict.kind).toBe("review")
  if (conflict.kind !== "review")
    throw new Error("Expected a baseline conflict")
  expect(
    conflict.candidates.map(
      ({ requirementChecklist }) => requirementChecklist?.baselineUrl,
    ),
  ).toEqual([source, undefined])
  expect(() =>
    renderSpecRequirementChecklist({ baselineUrl: source, requirements: [] }),
  ).toThrow()
  expect(() =>
    renderSpecRequirementChecklist({
      baselineUrl: source,
      requirements: [...requirements, requirements[0]],
    }),
  ).toThrow()
})

test("the approved parent and exact design survive a local-only child edit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rfa-spec-"))
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Spec Test",
        "-c",
        "user.email=spec@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trimEnd()
  try {
    git("init")
    const commitDesign = (text: string) => {
      writeFileSync(join(cwd, "design.md"), `${text}\n`)
      git("add", "design.md")
      git("commit", "-m", "Update design")
      return git("rev-parse", "HEAD")
    }
    const approvedCommit = commitDesign(approved)
    const revision = `https://github.com/acme/widgets/blob/${approvedCommit}/design.md`
    const approvedBody = `${approved}\n\n[Design](${revision})\n`
    const original = {
      title: parent.title,
      body: approvedBody,
      designRevisions: [revision],
    }
    const comment = renderSpecBaseline(original)
    commitDesign(localSlice)

    const result = resolveSpecBaseline(
      { ...parent, body: cite(localSlice, source) },
      [
        { body: comment, url: source, edited: false },
        {
          body: localSlice,
          url: `${parent.url}#issuecomment-2`,
          edited: false,
        },
      ],
    )
    expect(result).toEqual({
      kind: "baseline",
      baseline: {
        ...original,
        source: { kind: "publication-comment", url: source },
      },
    })
    if (result.kind !== "baseline") throw new Error("No approved baseline")
    const pinnedCommit = new URL(
      result.baseline.designRevisions[0] ?? "",
    ).pathname.split("/")[4]
    expect(git("show", `${pinnedCommit}:design.md`)).toBe(approved)
    expect(git("show", "HEAD:design.md")).toBe(localSlice)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("a late-marked Spec preserves identifiable approved revisions over live links", () => {
  const body = `${approved}\n\n[Approved design baseline: ADR](<${oldLink}>) · [Current design](${mutableLink})`
  const { title, url } = parent
  expect(resolveSpecBaseline({ ...parent, body }, [])).toEqual({
    kind: "baseline",
    baseline: {
      title,
      body,
      designRevisions: [oldLink],
      source: { kind: "marked-parent", url },
    },
  })
})

test("recovers bare pinned URLs only inside the approved design section", () => {
  const body = `## Background\n\n${conflictingLink}\n\n## Approved design revisions\n\n### Server\n\n${oldLink}\n- ${mutableLink}\n\n## Further notes\n\n${conflictingLink}`
  expect(resolveSpecBaseline({ ...parent, body }, [])).toEqual({
    kind: "baseline",
    baseline: {
      title: parent.title,
      body,
      designRevisions: [oldLink],
      source: { kind: "marked-parent", url: parent.url },
    },
  })
})

test("recovers a nested approved design list item without treating list code as a design", () => {
  const body = `## Approved design revisions\n\n    - ${conflictingLink}\n\n- Architecture\n    - ${oldLink}\n\n- Example only\n\n      - ${conflictingLink}\n\n- Fenced example\n\n    \`\`\`md\n    - ${conflictingLink}\n    \`\`\``
  expect(resolveSpecBaseline({ ...parent, body }, [])).toMatchObject({
    kind: "baseline",
    baseline: { body, designRevisions: [oldLink] },
  })
})

test.each(["1.", "1)"])(
  "recovers a bare pinned URL from an approved design list with marker %s",
  (marker) => {
    const body = `## Approved design revisions\n\n${marker} ${oldLink}\n\n## Further notes\n\n${marker} ${conflictingLink}`
    expect(resolveSpecBaseline({ ...parent, body }, [])).toMatchObject({
      kind: "baseline",
      baseline: { body, designRevisions: [oldLink] },
    })
  },
)

test.each([
  `${oldLink} "Approved architecture"`,
  `<${oldLink}> 'Approved architecture'`,
  `${oldLink} (Approved architecture)`,
])(
  "recovers the exact pinned destination of a titled design link (%s)",
  (target) => {
    const body = `${approved}\n\n## Approved design revisions\n\n[Design](${target})`
    expect(resolveSpecBaseline({ ...parent, body }, [])).toMatchObject({
      kind: "baseline",
      baseline: { body, designRevisions: [oldLink] },
    })
  },
)

test("excludes escaped design examples but keeps links after a literal backslash", () => {
  const body = String.raw`Example: \[Design](${conflictingLink})

${approved} See \\[Design](${oldLink}).`
  expect(resolveSpecBaseline({ ...parent, body }, [])).toMatchObject({
    kind: "baseline",
    baseline: { body, designRevisions: [oldLink] },
  })
})

test("a literal exclamation mark before a design link is not an image embed", () => {
  const body = String.raw`${approved} See \![Design](${oldLink}).`
  expect(resolveSpecBaseline({ ...parent, body }, [])).toMatchObject({
    kind: "baseline",
    baseline: { body, designRevisions: [oldLink] },
  })
})

test("marking an existing parent with a snapshot keeps its promise across later reads", () => {
  const existing = { ...parent, marked: false, body: approved }
  const snapshot = renderSpecBaseline({
    title: existing.title,
    body: existing.body,
    designRevisions: [oldLink],
  })
  const comments = [{ body: snapshot, url: source, edited: false }]
  expect(resolveSpecBaseline(existing, comments)).toEqual({ kind: "not-spec" })

  const marked = { ...existing, marked: true, body: cite(approved, source) }
  const captured = {
    kind: "baseline",
    baseline: {
      title: existing.title,
      body: approved,
      designRevisions: [oldLink],
      source: { kind: "publication-comment", url: source },
    },
  }
  expect(resolveSpecBaseline(marked, comments)).toEqual(captured)
  expect(
    resolveSpecBaseline(
      { ...marked, body: cite(localSlice, source) },
      comments,
    ),
  ).toEqual(captured)
})

test("recovers archived approved text and a separate design reference over a local-only edit", () => {
  const designUrl = `${parent.url}#issuecomment-2`
  expect(
    resolveSpecBaseline(
      {
        ...parent,
        body: cite(localSlice, source, designUrl),
      },
      [
        {
          body: `Approved in our meeting:\n\n## Approved Spec baseline\n\n${approved}`,
          url: source,
          edited: false,
        },
        {
          body: `Before implementation: [Approved design baseline: ADR](<${oldLink}>)`,
          url: designUrl,
          edited: false,
        },
        {
          body: localSlice,
          url: `${parent.url}#issuecomment-3`,
          edited: false,
        },
      ],
    ),
  ).toEqual({
    kind: "baseline",
    baseline: {
      title: parent.title,
      body: approved,
      designRevisions: [oldLink],
      source: { kind: "historical-approval-comment", url: source },
      designRevisionSources: [{ revision: oldLink, commentUrl: designUrl }],
    },
  })
})

test("recovers archived approval cited inline in the marked parent's prose", () => {
  expect(
    resolveSpecBaseline(
      {
        ...parent,
        body: `${localSlice}\n\nFor <code>MCP</code>, approved scope: ${approvalLink(source)}.`,
      },
      [
        {
          body: `## Approved Spec baseline\n\n${approved}`,
          url: source,
          edited: false,
        },
      ],
    ),
  ).toMatchObject({
    kind: "baseline",
    baseline: {
      body: approved,
      source: { kind: "historical-approval-comment", url: source },
    },
  })
})

test("recovers the approved archive section without later child implementation notes", () => {
  const archived = `${approved}\n\n### Acceptance\n\n\`\`\`md\n## Example\n\`\`\`\n\nThe deployed endpoint must work.\n\n### Approved design revisions\n\n#### Server\n\n${oldLink}\n\n### Background\n\n${conflictingLink}`
  const comment = `## Approved Spec baseline\n\n${archived}\n\n## Child implementation notes\n\n${localSlice}\n\n[Approved design baseline](${conflictingLink})`
  expect(
    resolveSpecBaseline({ ...parent, body: cite(localSlice, source) }, [
      { body: comment, url: source, edited: false },
    ]),
  ).toEqual({
    kind: "baseline",
    baseline: {
      title: parent.title,
      body: archived,
      designRevisions: [oldLink],
      source: { kind: "historical-approval-comment", url: source },
      designRevisionSources: [{ revision: oldLink, commentUrl: source }],
    },
  })
})

test("recovers an incorporated pinned Design link from an approved archive", () => {
  const archived = `${approved} See [Design](${oldLink}).`
  expect(
    resolveSpecBaseline({ ...parent, body: cite(localSlice, source) }, [
      {
        body: `## Approved Spec baseline\n\n${archived}`,
        url: source,
        edited: false,
      },
    ]),
  ).toMatchObject({
    kind: "baseline",
    baseline: {
      body: archived,
      designRevisions: [oldLink],
      source: { kind: "historical-approval-comment", url: source },
    },
  })
})

test.each([
  `Example: \`[Design](${conflictingLink})\``,
  `    [Design](${conflictingLink})`,
  `<pre class="example">\n[Design](${conflictingLink})\n</pre>`,
  `Screenshot: ![Design](${conflictingLink.replace("/design.md", "/screenshot.png")})`,
])(
  "does not count an illustrative link as an incorporated design (%j)",
  (example) => {
    const body = `${example}\n\n${approved} See [Design](${oldLink}).`
    expect(resolveSpecBaseline({ ...parent, body }, [])).toMatchObject({
      kind: "baseline",
      baseline: { body, designRevisions: [oldLink] },
    })
    expect(
      resolveSpecBaseline({ ...parent, body: cite(localSlice, source) }, [
        {
          body: `## Approved Spec baseline\n\n${body}`,
          url: source,
          edited: false,
        },
      ]),
    ).toMatchObject({
      kind: "baseline",
      baseline: {
        body,
        designRevisions: [oldLink],
        source: { kind: "historical-approval-comment", url: source },
      },
    })
  },
)

test("an archive heading inside a quoted code example does not identify approved text", () => {
  const body = cite(approved, source)
  expect(
    resolveSpecBaseline({ ...parent, body }, [
      {
        body: `Example format:\n\n\`\`\`md\n## Approved Spec baseline\n\n${localSlice}\n\`\`\``,
        url: source,
        edited: false,
      },
    ]),
  ).toMatchObject({
    kind: "review",
    candidates: [{ body, source: { kind: "marked-parent", url: parent.url } }],
    unreadableSnapshots: [source],
  })
})

test("keeps a live-only design addition separate from a cited archived approval", () => {
  const newDesign = oldLink.replace("/design.md", "/local-only.md")
  const archived = `${approved}\n\n[Approved design baseline](${oldLink})`
  const comments = [
    {
      body: `## Approved Spec baseline\n\n${archived}`,
      url: source,
      edited: false,
    },
  ]
  const liveBody = (revision: string) =>
    cite(`${localSlice}\n\n[Design](${revision})`, source)

  expect(
    resolveSpecBaseline({ ...parent, body: liveBody(newDesign) }, comments),
  ).toMatchObject({
    kind: "review",
    candidates: [
      { designRevisions: [newDesign], source: { url: parent.url } },
      { body: archived, designRevisions: [oldLink], source: { url: source } },
    ],
  })
  expect(
    resolveSpecBaseline({ ...parent, body: liveBody(oldLink) }, comments),
  ).toMatchObject({
    kind: "baseline",
    baseline: { body: archived, designRevisions: [oldLink] },
  })
})

test("a self-declared approval cannot narrow the parent promise", () => {
  expect(
    resolveSpecBaseline({ ...parent, body: approved }, [
      {
        body: `## Approved Spec baseline\n\n${localSlice}`,
        url: source,
        edited: false,
      },
    ]),
  ).toMatchObject({
    kind: "review",
    candidates: [
      { body: approved, source: { kind: "marked-parent", url: parent.url } },
      {
        body: localSlice,
        source: { kind: "historical-approval-comment", url: source },
      },
    ],
  })
})

test("uses the marked parent text with a corroborated approved design reference from a comment", () => {
  const body = cite(approved, source)
  expect(
    resolveSpecBaseline({ ...parent, body }, [
      {
        body: `[Approved design baseline](${oldLink})`,
        url: source,
        edited: false,
      },
    ]),
  ).toEqual({
    kind: "baseline",
    baseline: {
      title: parent.title,
      body,
      designRevisions: [oldLink],
      source: { kind: "marked-parent", url: parent.url },
      designRevisionSources: [{ revision: oldLink, commentUrl: source }],
    },
  })
})

test("does not incorporate an uncorroborated design from a comment", () => {
  expect(
    resolveSpecBaseline({ ...parent, body: approved }, [
      {
        body: `[Approved design baseline](${oldLink})`,
        url: source,
        edited: false,
      },
    ]),
  ).toMatchObject({
    kind: "review",
    candidates: [
      { body: approved, designRevisions: [], source: { url: parent.url } },
      { designRevisions: [oldLink], source: { url: source } },
    ],
  })
})

test.each([
  "",
  `\n\nExample only:\n\n\`\`\`md\n${approvalLink(source)}\n\`\`\``,
  `\n\nExample only:\n\n\`\`\`md\nApproved scope: ${approvalLink(source)}\n\`\`\``,
  `\n\nExample only: \`${approvalLink(source)}\``,
  `\n\nExample only: \`Approved scope:\n${approvalLink(source)}\``,
  `\n\n<!-- Not approved:\nApproved scope: ${approvalLink(source)}\n-->`,
  `\n\nExample markup:\n<pre>\n[Approved Spec baseline](${source})\n</pre>`,
  `\n\nExample markup: <code>[Approved Spec baseline](${source})</code>`,
])(
  "an uncorroborated publication-shaped comment cannot narrow the parent promise (%j)",
  (example) => {
    const parentBody = approved + example
    const body = renderSpecBaseline({
      title: parent.title,
      body: localSlice,
      designRevisions: [],
    })
    expect(
      resolveSpecBaseline({ ...parent, body: parentBody }, [
        { body, url: source, edited: false },
      ]),
    ).toMatchObject({
      kind: "review",
      candidates: [
        {
          body: parentBody,
          source: { kind: "marked-parent", url: parent.url },
        },
        { body: localSlice, source: { url: source } },
      ],
    })
  },
)

test("a missing cited snapshot leaves the parent available for review", () => {
  const body = cite(localSlice, source)
  expect(resolveSpecBaseline({ ...parent, body }, [])).toMatchObject({
    kind: "review",
    candidates: [{ body, source: { kind: "marked-parent", url: parent.url } }],
    unreadableSnapshots: [source],
  })
})

test("keeps two different approved texts for review, separately from the live parent", () => {
  const other = `${parent.url}#issuecomment-2`
  expect(
    resolveSpecBaseline(parent, [
      {
        body: `## Approved Spec baseline\n\n${approved}`,
        url: source,
        edited: false,
      },
      {
        body: "## Approved Spec baseline\n\nDeliver only the deployed endpoint.",
        url: other,
        edited: false,
      },
    ]),
  ).toMatchObject({
    kind: "review",
    candidates: [
      { body: localSlice, source: { kind: "marked-parent", url: parent.url } },
      { body: approved, source: { url: source } },
      { body: "Deliver only the deployed endpoint.", source: { url: other } },
    ],
  })
})

test("keeps distinct approved commits of the same document for review", () => {
  const body = `${approved}\n[Approved design baseline](${oldLink})`
  expect(
    resolveSpecBaseline({ ...parent, body }, [
      {
        body: `[Approved design baseline](${conflictingLink}#scope)`,
        url: source,
        edited: false,
      },
    ]),
  ).toMatchObject({
    kind: "review",
    candidates: [
      { body, designRevisions: [oldLink], source: { url: parent.url } },
      {
        designRevisions: [`${conflictingLink}#scope`],
        source: { url: source },
      },
    ],
  })
})

test("keeps conflicting revisions inside a single publication snapshot for review", () => {
  const original = {
    title: parent.title,
    body: approved,
    designRevisions: [oldLink, conflictingLink],
  }
  expect(
    resolveSpecBaseline({ ...parent, body: cite(parent.body, source) }, [
      { body: renderSpecBaseline(original), url: source, edited: false },
    ]),
  ).toEqual({
    kind: "review",
    candidates: [
      { ...original, source: { kind: "publication-comment", url: source } },
    ],
    unreadableSnapshots: [],
  })
})

test("keeps live design claims separate from a cited publication snapshot", () => {
  const original = {
    title: parent.title,
    body: approved,
    designRevisions: [oldLink],
  }
  const published = {
    ...original,
    source: { kind: "publication-comment", url: source },
  }
  const comments = [
    { body: renderSpecBaseline(original), url: source, edited: false },
  ]
  const liveBody = (revision: string) =>
    cite(`${localSlice}\n\n[Design](${revision})`, source)

  for (const revision of [
    conflictingLink,
    oldLink.replace("/design.md", "/local-only.md"),
  ]) {
    const body = liveBody(revision)
    expect(resolveSpecBaseline({ ...parent, body }, comments)).toMatchObject({
      kind: "review",
      candidates: [
        published,
        { body, designRevisions: [revision], source: { url: parent.url } },
      ],
    })
  }
  const screenshot = oldLink.replace("/design.md", "/screenshot.png")
  for (const body of [
    cite(localSlice, source),
    liveBody(oldLink),
    cite(`${localSlice}\n\nScreenshot: ![Design](${screenshot})`, source),
  ]) {
    expect(resolveSpecBaseline({ ...parent, body }, comments)).toEqual({
      kind: "baseline",
      baseline: published,
    })
  }
})

test("a historical comment cannot amend a publication snapshot", () => {
  const original = {
    title: parent.title,
    body: approved,
    designRevisions: [oldLink],
  }
  const later = `${parent.url}#issuecomment-2`
  const claimedAmendment = `## Approved Spec baseline\n\n${localSlice}`
  expect(
    resolveSpecBaseline({ ...parent, body: cite(parent.body, source) }, [
      { body: renderSpecBaseline(original), url: source, edited: false },
      { body: claimedAmendment, url: later, edited: false },
    ]),
  ).toMatchObject({
    kind: "review",
    candidates: [
      { ...original, source: { kind: "publication-comment", url: source } },
      {
        body: localSlice,
        source: { kind: "historical-approval-comment", url: later },
      },
    ],
  })
})

test("without approval evidence, use the marked parent as written, never the live design", () => {
  const body = `${approved}\n\n[Design](${mutableLink})`
  expect(resolveSpecBaseline({ ...parent, body }, [])).toEqual({
    kind: "baseline",
    baseline: {
      title: parent.title,
      body,
      designRevisions: [],
      source: { kind: "marked-parent", url: parent.url },
    },
  })
  expect(resolveSpecBaseline({ ...parent, marked: false }, [])).toEqual({
    kind: "not-spec",
  })
  expect(() =>
    renderSpecBaseline({
      title: parent.title,
      body,
      designRevisions: [mutableLink],
    }),
  ).toThrow()
})

test("keep conflicting captures and edited snapshot evidence without choosing an amendment", () => {
  const snapshot = (body: string, url: string, edited = false) => ({
    body: renderSpecBaseline({
      title: parent.title,
      body,
      designRevisions: [],
    }),
    url,
    edited,
  })
  const later = `${parent.url}#issuecomment-2`
  const edited = `${parent.url}#issuecomment-3`
  const body = cite(parent.body, later)
  const result = resolveSpecBaseline({ ...parent, body }, [
    snapshot(localSlice, later),
    snapshot(approved, source),
    snapshot("deployment waived", edited, true),
  ])
  expect(result).toMatchObject({
    kind: "review",
    candidates: [
      { body: localSlice, source: { url: later } },
      { body: approved, source: { url: source } },
      { body, source: { kind: "marked-parent", url: parent.url } },
    ],
    unreadableSnapshots: [edited],
  })
})

test("keeps fallback parent evidence alongside one readable and one unreadable snapshot", () => {
  const edited = `${parent.url}#issuecomment-2`
  const readableBody = renderSpecBaseline({
    title: parent.title,
    body: approved,
    designRevisions: [oldLink],
  })
  const body = cite(localSlice, source)
  expect(
    resolveSpecBaseline({ ...parent, body }, [
      { body: readableBody, url: source, edited: false },
      { body: readableBody, url: edited, edited: true },
    ]),
  ).toMatchObject({
    kind: "review",
    candidates: [
      { body: approved, source: { kind: "publication-comment", url: source } },
      { body, source: { kind: "marked-parent", url: parent.url } },
    ],
    unreadableSnapshots: [edited],
  })
})

test("keeps fallback parent text and provenance when the only snapshot was edited", () => {
  const body = renderSpecBaseline({
    title: parent.title,
    body: localSlice,
    designRevisions: [],
  })
  expect(
    resolveSpecBaseline({ ...parent, body: approved }, [
      { body, url: source, edited: true },
    ]),
  ).toEqual({
    kind: "review",
    candidates: [
      {
        title: parent.title,
        body: approved,
        designRevisions: [],
        source: { kind: "marked-parent", url: parent.url },
      },
    ],
    unreadableSnapshots: [source],
  })
})
