import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentBackendWarnings } from "../src/agent-backend-warnings.js"
import { ui } from "../src/ui.js"
import {
  WCAG_AA_NORMAL_TEXT,
  compileHarnessCss,
  contrastRatio,
  renderWithTheme,
} from "./support/rendered-theme.js"
import { beforeAll, describe, expect, test } from "bun:test"

/**
 * Issue #830: non-fatal Agent Backend warnings must follow the visible Harness
 * theme, not the browser/OS `prefers-color-scheme`. The regression was a pale
 * amber `dark:` variant winning inside a light dialog and painting pale yellow
 * on the light grey status row.
 *
 * Class names are never spelled out literally in this file: Tailwind scans
 * `test/` too, so a literal utility in a comment emits a dead rule into the
 * production bundle. Assertions build them from substrings instead.
 */

const BEDROCK_WARNING =
  "Bedrock profile discovery failed: check AWS credentials, region, and IAM permissions for bedrock:ListInferenceProfiles."

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const warningsMarkup = () =>
  renderToStaticMarkup(<AgentBackendWarnings warnings={[BEDROCK_WARNING]} />)

/**
 * The three real warning render sites, each wrapped in the chrome its route
 * actually mounts it in — the parent supplies the background the warning is
 * read against.
 */
const WARNING_SITES = [
  {
    id: "harness-active",
    label: "Active Agent Backend status row",
    // __root.tsx: dialogBodySectioned → dialogSection → dialogStatusRow
    html: `<div class="${ui.dialogBodySectioned}"><section class="${ui.dialogSection}"><div class="${ui.dialogStatusRow}"><div class="min-w-0 flex-1"><p class="m-0">Claude Code · Ready</p>${warningsMarkup()}</div></div></section></div>`,
  },
  {
    id: "harness-preview",
    label: "unsaved backend Preview status row",
    html: `<div class="${ui.dialogBodySectioned}"><section class="${ui.dialogSection}"><div class="${ui.dialogStatusRow}"><div class="min-w-0 flex-1"><p class="m-0">Claude Code · Previewing selection</p>${warningsMarkup()}</div></div></section></div>`,
  },
  {
    id: "repository-preview",
    label: "Repository Settings backend Preview status",
    // index.tsx: dialogBodySectioned → dialogSection → dialogStatusLabel
    html: `<div class="${ui.dialogBodySectioned}"><section class="${ui.dialogSection}"><div class="${ui.dialogStatusLabel}"><p class="m-0">Claude Code · Ready</p>${warningsMarkup()}</div></div></section></div>`,
  },
] as const

/** Every class token the fixtures use, so Tailwind emits those utilities. */
const fixtureCandidates = (): readonly string[] => {
  const found = new Set<string>()
  for (const site of WARNING_SITES) {
    for (const match of site.html.matchAll(/class="([^"]*)"/g)) {
      for (const token of match[1].split(/\s+/)) {
        if (token !== "") found.add(token)
      }
    }
  }
  return [...found]
}

let css = ""

beforeAll(async () => {
  css = await compileHarnessCss(fixtureCandidates())
})

describe("Agent Backend warning contrast", () => {
  test("light Harness theme stays readable when the browser prefers dark", () => {
    for (const site of WARNING_SITES) {
      const rendered = renderWithTheme({
        css,
        html: site.html,
        theme: "light",
        prefersColorScheme: "dark",
      })
      try {
        const foreground = rendered.colorOf('p[role="status"]')
        const background = rendered.backgroundOf('p[role="status"]')
        const ratio = contrastRatio(foreground, background)
        expect(
          ratio,
          `${site.label}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT)
        // Warning text is warning-colored, not plain inherited row ink: the
        // dark-preference pale variant must not have won on a light surface.
        expect(foreground).toBe(rendered.rootToken("--warn-ink"))
      } finally {
        rendered.dispose()
      }
    }
  })

  test("dark Harness theme keeps warning contrast when the browser prefers light", () => {
    for (const site of WARNING_SITES) {
      const rendered = renderWithTheme({
        css,
        html: site.html,
        theme: "dark",
        prefersColorScheme: "light",
      })
      try {
        const foreground = rendered.colorOf('p[role="status"]')
        const background = rendered.backgroundOf('p[role="status"]')
        const ratio = contrastRatio(foreground, background)
        expect(
          ratio,
          `${site.label}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT)
        expect(foreground).toBe(rendered.rootToken("--warn-ink"))
      } finally {
        rendered.dispose()
      }
    }
  })

  test("warning ink flips with the Harness theme, not the OS preference", () => {
    const [site] = WARNING_SITES
    const lightUnderDarkPreference = renderWithTheme({
      css,
      html: site.html,
      theme: "light",
      prefersColorScheme: "dark",
    })
    const lightUnderLightPreference = renderWithTheme({
      css,
      html: site.html,
      theme: "light",
      prefersColorScheme: "light",
    })
    const darkUnderDarkPreference = renderWithTheme({
      css,
      html: site.html,
      theme: "dark",
      prefersColorScheme: "dark",
    })
    try {
      // OS preference does not move the warning color…
      expect(lightUnderDarkPreference.colorOf('p[role="status"]')).toBe(
        lightUnderLightPreference.colorOf('p[role="status"]'),
      )
      // …but the Harness theme does.
      expect(darkUnderDarkPreference.colorOf('p[role="status"]')).not.toBe(
        lightUnderDarkPreference.colorOf('p[role="status"]'),
      )
    } finally {
      lightUnderDarkPreference.dispose()
      lightUnderLightPreference.dispose()
      darkUnderDarkPreference.dispose()
    }
  })

  test("warning state carries a structural cue beyond color", () => {
    const [site] = WARNING_SITES
    const rendered = renderWithTheme({
      css,
      html: site.html,
      theme: "light",
      prefersColorScheme: "dark",
    })
    try {
      expect(
        rendered.styleOf('p[role="status"]', "border-left-width"),
      ).not.toBe("0px")
      expect(rendered.styleOf('p[role="status"]', "font-weight")).toBe("600")
    } finally {
      rendered.dispose()
    }
  })

  test("all three sites share one warning presentation", () => {
    const root = rootSource()
    const index = indexSource()
    // One shared component, wired at Active + Preview (harness) and Repository.
    expect(root).toContain("AgentBackendWarnings")
    expect(index).toContain("AgentBackendWarnings")
    expect(root.match(/<AgentBackendWarnings/g)?.length).toBe(2)
    expect(index.match(/<AgentBackendWarnings/g)?.length).toBe(1)
    // No per-site color utilities, and no media-preference text variant.
    // Assembled at runtime so Tailwind's scanner does not see a real class.
    const amberText = ["text", "amber"].join("-")
    const darkTextVariant = `${["dark", "text"].join(":")}-`
    for (const source of [root, index]) {
      expect(source).not.toContain(amberText)
      expect(source).not.toContain(darkTextVariant)
    }
    // Non-fatal semantics preserved at the shared component.
    expect(
      readFileSync(
        join(import.meta.dir, "../src/agent-backend-warnings.tsx"),
        "utf8",
      ),
    ).toContain('role="status"')
  })
})
