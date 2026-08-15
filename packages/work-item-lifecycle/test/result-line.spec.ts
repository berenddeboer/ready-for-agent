import {
  boundResultCandidate,
  classifyUnparsedResult,
  formatResultLineFailure,
  lastNormalizedResultCandidate,
  lastValidResult,
  normalizeResultCandidateLine,
  quotedResultCandidateSuffix,
  resultCandidateLines,
  resultNameFromLine,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("normalizeResultCandidateLine", () => {
  it("trims whitespace and unwraps one inline-code wrapper", () => {
    expect(
      normalizeResultCandidateLine("  READY_FOR_AGENT_RESULT: PASS  "),
    ).toBe("READY_FOR_AGENT_RESULT: PASS")
    expect(
      normalizeResultCandidateLine("`READY_FOR_AGENT_RESULT: REVIEW_CLEAN`"),
    ).toBe("READY_FOR_AGENT_RESULT: REVIEW_CLEAN")
    expect(
      normalizeResultCandidateLine("  `READY_FOR_AGENT_RESULT: PASS`  "),
    ).toBe("READY_FOR_AGENT_RESULT: PASS")
  })

  it("does not unwrap unmatched or nested markdown", () => {
    expect(normalizeResultCandidateLine("`READY_FOR_AGENT_RESULT: PASS")).toBe(
      "`READY_FOR_AGENT_RESULT: PASS",
    )
    expect(
      normalizeResultCandidateLine("``READY_FOR_AGENT_RESULT: PASS``"),
    ).toBe("``READY_FOR_AGENT_RESULT: PASS``")
  })
})

describe("resultCandidateLines", () => {
  it("collects markdown-wrapped and plain result-looking lines in order", () => {
    expect(
      resultCandidateLines(
        [
          "prose",
          "`READY_FOR_AGENT_RESULT: PASS`",
          "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
        ].join("\n"),
      ),
    ).toEqual([
      "READY_FOR_AGENT_RESULT: PASS",
      "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
    ])
  })

  it("ignores lines that only mention the prefix after other text", () => {
    expect(
      resultCandidateLines("see READY_FOR_AGENT_RESULT: PASS in the docs"),
    ).toEqual([])
  })
})

describe("lastValidResult", () => {
  const parseClean = (line: string) =>
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_CLEAN$/i.test(line)
      ? ({ _tag: "clean" } as const)
      : null

  it("keeps the last valid known marker and ignores unknown ones", () => {
    expect(
      lastValidResult(
        [
          "READY_FOR_AGENT_RESULT: PASS",
          "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
          "trailing prose",
        ].join("\n"),
        parseClean,
      ),
    ).toEqual({ _tag: "clean" })
  })

  it("returns null when only unknown or malformed candidates exist", () => {
    expect(
      lastValidResult("`READY_FOR_AGENT_RESULT: PASS`", parseClean),
    ).toBeNull()
    expect(lastValidResult("no marker", parseClean)).toBeNull()
  })
})

describe("classifyUnparsedResult", () => {
  const reviewNames = new Set(["REVIEW_CLEAN", "REVIEW_HAS_FINDINGS"])

  it("classifies missing, unknown, invalid argument, and invalid payload", () => {
    expect(classifyUnparsedResult("no marker", reviewNames)).toEqual({
      kind: "missing",
      lastCandidate: null,
    })
    expect(
      classifyUnparsedResult("`READY_FOR_AGENT_RESULT: PASS`", reviewNames),
    ).toEqual({
      kind: "unknown_result",
      lastCandidate: "READY_FOR_AGENT_RESULT: PASS",
    })
    expect(
      classifyUnparsedResult(
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: critical",
        reviewNames,
      ),
    ).toEqual({
      kind: "invalid_argument",
      lastCandidate: "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: critical",
    })
    expect(
      classifyUnparsedResult(
        "READY_FOR_AGENT_RESULT: PUBLICATION_COPY {",
        new Set(["PUBLICATION_COPY"]),
        { payloadName: "PUBLICATION_COPY" },
      ),
    ).toEqual({
      kind: "invalid_payload",
      lastCandidate: "READY_FOR_AGENT_RESULT: PUBLICATION_COPY {",
    })
  })
})

describe("quotedResultCandidateSuffix", () => {
  it("quotes the last normalized candidate without storing surrounding prose", () => {
    expect(
      quotedResultCandidateSuffix(
        "lots of prose\n`READY_FOR_AGENT_RESULT: PASS`\nmore",
      ),
    ).toBe(' (got "READY_FOR_AGENT_RESULT: PASS")')
    expect(quotedResultCandidateSuffix("no marker")).toBe("")
  })

  it("bounds a long candidate", () => {
    const long = `READY_FOR_AGENT_RESULT: PASS ${"x".repeat(600)}`
    expect(boundResultCandidate(long).length).toBeLessThanOrEqual(501)
    expect(formatResultLineFailure("unknown_result", long)).toContain(
      "unknown result",
    )
    expect(resultNameFromLine(long)).toBe("PASS")
    expect(lastNormalizedResultCandidate(long)).toBe(long)
  })
})
