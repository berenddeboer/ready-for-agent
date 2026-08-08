export type CompletedSearch = {
  readonly page?: number
}

const positiveInteger = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Validate the Completed archive's URL-owned page at the router boundary. */
export const parseCompletedSearch = (
  raw: Record<string, unknown>,
): CompletedSearch => {
  const page = positiveInteger(raw.page)
  // TanStack merges validated search over raw search, so an explicit
  // undefined is required to prevent invalid/page-1 input leaking through.
  return { page: page === 1 ? undefined : page }
}

/** Page 1 is canonical as bare `/completed`; later pages carry `?page=`. */
export const completedPageSearch = (page: number): CompletedSearch =>
  page <= 1 ? {} : { page }

/** Whether the address bar already uses the canonical search for this page. */
export const isCompletedPageSearchCanonical = (input: {
  readonly rawPage: unknown
  readonly page: number
}): boolean => input.rawPage === (input.page === 1 ? undefined : input.page)
