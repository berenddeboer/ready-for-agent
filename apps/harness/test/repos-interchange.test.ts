import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

const sliceBetweenMarkers = (
  source: string,
  startMarker: string,
  endMarker: string,
): string => {
  const start = source.indexOf(startMarker)
  if (start < 0) {
    throw new Error(`Start marker not found: ${startMarker}`)
  }
  const end = source.indexOf(endMarker, start)
  if (end < 0) {
    throw new Error(`End marker not found after ${startMarker}: ${endMarker}`)
  }
  return source.slice(start, end)
}

/**
 * Interchange phase 4 — repos page + blank slate (issue #703 / §4.6–4.7).
 * Structural + design-token contract tests; no behavior changes.
 */
describe("Interchange phase 4: repos page + blank slate", () => {
  test("repo cards use 1.5px ticket shell, display title, mono PR count, icon controls", () => {
    const source = homeSource()
    // Card chrome only (settings dialog stays on Ledger until phase 5).
    const head = sliceBetweenMarkers(source, 'className="repo-card"', "<dialog")
    expect(head).toContain("repo-card-title")
    expect(head).toContain("repo-card-link")
    expect(head).toContain("repo-card-pr-count")
    expect(head).toContain("repo-card-controls")
    expect(head).toContain("icon-btn")
    expect(head).not.toContain("font-serif")
    expect(head).not.toContain("border-t-2 border-ink-soft")
    // Pause/armed classes are composed above the JSX return.
    expect(source).toContain("icon-btn--paused")
    expect(source).toContain("icon-btn--armed")
    expect(source).toContain("pauseButtonClassName")
    expect(source).toContain('className="repo-card"')

    const styles = stylesSource()
    expect(styles).toContain(".repo-card {")
    expect(styles).toContain("border: 1.5px solid var(--ink)")
    expect(styles).toContain(".repo-card-title")
    expect(styles).toContain("font-size: 1.06rem")
    expect(styles).toContain("text-decoration-color: var(--signal)")
  })

  test("meta table is hairline two-column mono dt/dd with harness-default annotations", () => {
    const body = sliceBetweenMarkers(
      homeSource(),
      'className="repo-meta"',
      "function RepositoryIssues(",
    )
    expect(body).toContain("repo-meta-row")
    expect(body).toContain("Harness default (")
    expect(body).toContain("<dt>Path</dt>")
    expect(body).toContain("<dt>Agent Backend</dt>")

    const styles = stylesSource()
    expect(styles).toContain(".repo-meta {")
    expect(styles).toContain("border-top: 1px solid var(--line-ghost)")
    expect(styles).toContain("border-bottom: 1px solid var(--line-ghost)")
    expect(styles).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))")
  })

  test("credential banners use Attention tag, primary-plate CTAs, guidance-code chips", () => {
    const body = sliceBetweenMarkers(
      homeSource(),
      'className="repo-meta"',
      "function RepositoryIssues(",
    )
    expect(body).toContain('tag="Attention"')
    expect(body).toContain("GitHub token required")
    expect(body).toContain("GitLab authentication required")
    expect(body).toContain('className="plate-primary"')
    expect(body).toContain("Create GitHub token")
    expect(body).toContain("Store in Keymaxxer")
    expect(body).toContain('className="guidance-code"')

    const styles = stylesSource()
    expect(styles).toContain(".plate-primary")
    expect(styles).toContain(".guidance-code")
    expect(styles).toMatch(
      /\.plate-primary\s*\{[^}]*background:\s*var\(--ink\)/s,
    )
    expect(styles).toMatch(
      /\.plate-primary:hover\s*\{[^}]*background:\s*var\(--signal\)/s,
    )
  })

  test("relevant issues use ticket rows; Closed dashed stamp; Blocked Queue-yellow without wash", () => {
    const issues = sliceBetweenMarkers(
      homeSource(),
      "function RepositoryIssueRow(",
      "export function SessionUsageDialog(",
    )
    expect(issues).toContain('className="repo-issue"')
    expect(issues).toContain("repo-issue-num")
    expect(issues).toContain("repo-issue-title")
    expect(issues).toContain("repo-issue-author")
    expect(issues).toContain('className="stamp stamp--closed"')
    expect(issues).toContain("Closed")
    expect(issues).toContain('className="stamp stamp--blocked"')
    expect(issues).toContain("Blocked")
    expect(issues).toContain("repo-issue-blocked-by")
    expect(issues).toContain("Blocked by")
    // Old amber row-wash language is dropped.
    expect(issues).not.toContain("bg-amber-wash")
    expect(issues).not.toContain("border-sepia")
    expect(issues).not.toContain("text-sepia")
    expect(issues).not.toContain("font-serif")

    const styles = stylesSource()
    expect(styles).toContain(".stamp--closed")
    expect(styles).toContain(".stamp--blocked")
    expect(styles).toContain("border-style: dashed")
    expect(styles).toContain("background: var(--lane-queue)")
  })

  test("latest work item lifecycle chrome sits in 1.5px inset panel", () => {
    const lifecycle = sliceBetweenMarkers(
      homeSource(),
      "export function WorkItemLifecycleStatus(",
      "function RepositoryIssuesSkeleton(",
    )
    expect(lifecycle).toContain('compact ? "mt-2" : "lifecycle-inset"')

    const styles = stylesSource()
    expect(styles).toContain(".lifecycle-inset")
    expect(styles).toMatch(
      /\.lifecycle-inset\s*\{[^}]*border:\s*1\.5px solid var\(--ink\)/s,
    )
  })

  test("parent issue groups use details card and 2px line-soft child rule", () => {
    const parent = sliceBetweenMarkers(
      homeSource(),
      "function ParentIssueGroup(",
      "function RepositoryIssueRow(",
    )
    expect(parent).toContain('className="parent-issue"')
    expect(parent).toContain("parent-issue-children")
    expect(parent).toContain("parent-issue-closed-count")
    expect(parent).toContain("repo-issue-title")
    expect(parent).not.toContain("font-serif")
    // Implement-all failure is in-flow under the summary (not absolute on kebab).
    expect(parent).toContain("parent-issue-error")
    expect(parent).toContain("implementAll.isError")
    expect(parent).toContain('tone="alarm"')
    expect(parent).toContain("Could not start Implement all with auto-merge")
    expect(parent).toContain("errorMessage={null}")

    const styles = stylesSource()
    expect(styles).toContain(".parent-issue {")
    expect(styles).toContain(".parent-issue-children::before")
    expect(styles).toContain("width: 2px")
    expect(styles).toContain("background: var(--line-soft)")
    expect(styles).toContain(".parent-issue-error")
  })

  test("repos surface locks alarm Banner weighting for leaf/refresh/remove failures", () => {
    const source = homeSource()
    // Leaf implement/queue failures.
    const leaf = sliceBetweenMarkers(
      source,
      "function RepositoryIssueRow(",
      "export function SessionUsageDialog(",
    )
    expect(leaf).toContain("banner--compact repo-issue-error")
    expect(leaf).toContain('tone="alarm"')
    expect(leaf).toContain('tag="Error"')
    expect(leaf).toContain("Could not queue issue")
    expect(leaf).toContain("Could not start implementation")

    // Refresh + remove failures live on the card body (after settings dialog).
    const cardBody = sliceBetweenMarkers(
      source,
      'className="repo-meta"',
      "function RepositoryIssues(",
    )
    expect(cardBody).toContain("Failed to refresh issues.")
    expect(cardBody).toContain("Could not remove repository. Please try again.")
    expect(cardBody).toContain('className="banner--compact mb-2"')
    expect(cardBody).toContain('className="banner--compact mt-3"')
    expect(cardBody).toContain('tone="alarm"')
  })

  test("blank slate and plate-primary styles exist for shared zero-repo surface", () => {
    const styles = stylesSource()
    expect(styles).toContain(".blank-slate {")
    expect(styles).toContain("border: 2px dashed var(--ink)")
    expect(styles).toContain(".blank-slate-title")
    expect(styles).toContain(".blank-slate-fieldset")
    expect(styles).toContain(".blank-slate-divider")
    expect(styles).toContain(".plate-primary")
  })
})
