import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { Window } from "happy-dom"

/**
 * Render harness markup against the *real* compiled stylesheet so tests can
 * assert computed color behavior (theme tokens, contrast) instead of grepping
 * source for a color name.
 */

const harnessRoot = join(import.meta.dir, "../..")
const require_ = createRequire(import.meta.url)

/**
 * Strip `@layer` wrappers, hoisting their contents in place.
 *
 * happy-dom does not implement cascade layers: a rule inside `@layer` is
 * parsed but never applied, so every Tailwind utility would compute as unset.
 * Layer *order* does not matter here — Tailwind already emits theme → base →
 * utilities in source order, and specificity resolves the rest.
 */
function unwrapCssLayers(css: string): string {
  let out = ""
  let index = 0
  while (index < css.length) {
    const at = css.indexOf("@layer", index)
    if (at === -1) {
      out += css.slice(index)
      break
    }
    out += css.slice(index, at)
    const brace = css.indexOf("{", at)
    const semicolon = css.indexOf(";", at)
    // Statement form (`@layer theme, base;`) declares order only — drop it.
    if (brace === -1 || (semicolon !== -1 && semicolon < brace)) {
      if (semicolon === -1) break
      index = semicolon + 1
      continue
    }
    let depth = 1
    let cursor = brace + 1
    while (cursor < css.length && depth > 0) {
      const char = css[cursor]
      if (char === "{") depth += 1
      else if (char === "}") depth -= 1
      cursor += 1
    }
    out += unwrapCssLayers(css.slice(brace + 1, cursor - 1))
    index = cursor
  }
  return out
}

/**
 * Compile `src/styles.css` (tokens + `@theme` + base) plus the given candidate
 * class names through Tailwind, exactly as the Vite build does.
 */
export async function compileHarnessCss(
  candidates: readonly string[],
): Promise<string> {
  const { compile } = await import("tailwindcss")
  const stylesPath = join(harnessRoot, "src/styles.css")
  const compiler = await compile(readFileSync(stylesPath, "utf8"), {
    base: join(harnessRoot, "src"),
    loadStylesheet: async (id: string) => {
      if (id !== "tailwindcss") {
        throw new Error(`unexpected stylesheet import: ${id}`)
      }
      const path = require_.resolve("tailwindcss/index.css")
      return {
        path,
        base: dirname(path),
        content: readFileSync(path, "utf8"),
      }
    },
  })
  return unwrapCssLayers(compiler.build([...candidates]))
}

export type ThemeMode = "light" | "dark"

export type RenderedTheme = {
  /** Computed color of the first element matching `selector`. */
  readonly colorOf: (selector: string) => string
  /** Computed background color, walking up to the nearest painted ancestor. */
  readonly backgroundOf: (selector: string) => string
  /** Any computed style property of the first element matching `selector`. */
  readonly styleOf: (selector: string, property: string) => string
  /**
   * Value of a custom property on `<html>`. Read at the root because happy-dom
   * does not inherit custom properties into descendants' computed styles.
   */
  readonly rootToken: (property: string) => string
  readonly dispose: () => void
}

/**
 * Mount `html` under a pinned Harness theme while the emulated browser reports
 * its own `prefers-color-scheme`. The two differ on purpose: that mismatch is
 * the #830 regression seam.
 */
export function renderWithTheme(args: {
  readonly css: string
  readonly html: string
  readonly theme: ThemeMode
  readonly prefersColorScheme: ThemeMode
}): RenderedTheme {
  const window = new Window({
    url: "https://localhost/",
    settings: { device: { prefersColorScheme: args.prefersColorScheme } },
  })
  const { document } = window
  document.write(
    `<!doctype html><html data-theme="${args.theme}"><head><style>${args.css}</style></head><body>${args.html}</body></html>`,
  )

  const requireElement = (selector: string) => {
    const element = document.querySelector(selector)
    if (element === null) {
      throw new Error(`no element matched ${selector}`)
    }
    return element
  }

  const isPainted = (color: string) =>
    color !== "" && color !== "transparent" && color !== "rgba(0, 0, 0, 0)"

  return {
    colorOf: (selector) => {
      const color = window.getComputedStyle(requireElement(selector)).color
      // happy-dom cannot compute `oklch()` (Tailwind's palette format) and
      // yields "". Fail loudly rather than silently comparing empty strings.
      if (color === "") {
        throw new Error(`computed color for ${selector} is unresolvable`)
      }
      return color
    },
    backgroundOf: (selector) => {
      let node: ReturnType<typeof requireElement> | null =
        requireElement(selector)
      while (node !== null) {
        const background = window.getComputedStyle(node).backgroundColor
        if (isPainted(background)) return background
        node = node.parentElement
      }
      return ""
    },
    styleOf: (selector, property) =>
      window
        .getComputedStyle(requireElement(selector))
        .getPropertyValue(property),
    rootToken: (property) =>
      window
        .getComputedStyle(document.documentElement)
        .getPropertyValue(property),
    dispose: () => {
      window.close()
    },
  }
}

/** Relative luminance per WCAG 2.1 §relative luminance. */
function relativeLuminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Parse `#rgb`, `#rrggbb`, `rgb(r g b)`, or `rgb(r, g, b)`. */
function parseCssColor(value: string): readonly [number, number, number] {
  const text = value.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex !== null) {
    const digits = hex[1]
    const full =
      digits.length === 3
        ? digits
            .split("")
            .map((d) => d + d)
            .join("")
        : digits
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ]
  }
  const channels = text
    .replace(/^rgba?\(/i, "")
    .replace(/\)$/, "")
    .split(/[\s,/]+/)
    .filter((part) => part !== "")
    .slice(0, 3)
    .map(Number)
  if (channels.length !== 3 || channels.some(Number.isNaN)) {
    throw new Error(`unsupported color: ${value}`)
  }
  return [channels[0], channels[1], channels[2]]
}

/** WCAG 2.1 contrast ratio between two opaque colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(parseCssColor(a))
  const second = relativeLuminance(parseCssColor(b))
  const [lighter, darker] = first > second ? [first, second] : [second, first]
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG AA floor for normal-size body text. */
export const WCAG_AA_NORMAL_TEXT = 4.5
