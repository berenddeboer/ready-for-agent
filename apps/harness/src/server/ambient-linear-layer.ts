import { Layer } from "effect"
import {
  LINEAR_API_KEY_ENV_VAR,
  LinearService,
  type LinearServiceShape,
  makeAnonymousLinearService,
  makeLinearServiceFromToken,
} from "@ready-for-agent/linear-service"

/**
 * Ambient Linear service layer. Tolerates an absent LINEAR_API_KEY so Harness
 * startup is not blocked when Linear is unused. Keymaxxer injects the named
 * vault secret into helper processes instead of this in-process layer.
 */
export const ambientLinearLayer = (options: {
  readonly environment?: Partial<Record<string, string | undefined>>
  readonly makeService?: (token: string) => LinearServiceShape
  readonly makeAnonymousService?: () => LinearServiceShape
}): Layer.Layer<LinearService> => {
  const token = options.environment?.[LINEAR_API_KEY_ENV_VAR]?.trim()
  const makeService = options.makeService ?? makeLinearServiceFromToken
  const makeAnonymousService =
    options.makeAnonymousService ?? makeAnonymousLinearService
  return Layer.succeed(
    LinearService,
    token === undefined || token === ""
      ? makeAnonymousService()
      : makeService(token),
  )
}
