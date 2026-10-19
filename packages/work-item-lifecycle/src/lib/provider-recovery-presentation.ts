/**
 * Operator copy for a Provider Recovery Episode. Clock is an input so the UI
 * countdown and tests agree without sleeping. The persisted episode remains
 * the authority; these strings do not schedule work.
 */

export const PROVIDER_RECOVERY_BACKOFF_EXPLANATION =
  "Automatic recovery waits 1, 2, 4, 8, then 15 minutes, with a little jitter, and never earlier than a provider retry deadline. After an hour it retries every 30 minutes. The selected model stays."

export const PROVIDER_RECOVERY_MAX_WAIT_EXPLANATION =
  "Keep retrying is the default. A finite duration stops future automatic attempts once that time has elapsed from the original outage start, including after you change this setting. It does not restart the clock."

export const PROVIDER_RECOVERY_ESCALATION_MESSAGE =
  "Provider outage for over an hour. Automatic recovery continues at a slower pace."

export const PROVIDER_RECOVERY_EXHAUSTED_MESSAGE =
  "Automatic recovery stopped after the maximum wait. The session and work are kept. Retry to continue with the same model."

export const PROVIDER_RECOVERY_RECOVERED_MESSAGE =
  "Provider recovered. Automatic recovery finished."

export const PROVIDER_RECOVERY_PAUSED_MESSAGE =
  "Paused. Automatic recovery is cancelled and will not resume until Retry."

export const PROVIDER_RECOVERY_RETRYING_MESSAGE =
  "Retrying the same model after a provider outage."

export const PROVIDER_RECOVERY_CONTROLS_MESSAGE =
  "Pause cancels this scheduled attempt. Retry starts now and replaces it, without a second turn."

export const PROVIDER_RECOVERY_STATUSES = [
  "scheduled",
  "in_attempt",
  "recovered",
  "exited",
  "exhausted",
  "cancelled",
] as const

export type ProviderRecoveryStatus = (typeof PROVIDER_RECOVERY_STATUSES)[number]

export type ProviderRecoverySnapshot = {
  readonly status: ProviderRecoveryStatus
  readonly lifecycleStep: string
  readonly providerId: string | null
  readonly providerLabel: string | null
  readonly model: string | null
  readonly providerCode: string | null
  readonly reasonMessage: string | null
  readonly episodeStartedAt: number
  readonly attemptCount: number
  readonly nextAttemptAt: number | null
  readonly escalated: boolean
  readonly exhaustedAt: number | null
}

export const providerRecoveryIsOpen = (
  episode: Pick<ProviderRecoverySnapshot, "status">,
): boolean => episode.status === "scheduled" || episode.status === "in_attempt"

export const providerRecoveryCauseLabel = (
  episode: Pick<ProviderRecoverySnapshot, "reasonMessage" | "providerCode">,
): string => {
  const message = episode.reasonMessage ?? ""
  if (
    /at capacity/i.test(message) ||
    episode.providerCode === "server_overloaded"
  ) {
    return "Model at capacity"
  }
  if (/rate.?limit/i.test(message)) {
    return "Provider rate limited"
  }
  if (/overloaded/i.test(message)) {
    return "Provider overloaded"
  }
  return "Provider unavailable"
}

/** Ceiling to the next minute so a 3m01s wait does not read as already due. */
export const formatProviderRecoveryCountdown = (
  remainingMs: number,
): string => {
  if (remainingMs <= 0) {
    return "momentarily"
  }
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  if (minutes < 60) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourLabel = hours === 1 ? "1 hour" : `${hours} hours`
  if (rest === 0) {
    return hourLabel
  }
  const minuteLabel = rest === 1 ? "1 minute" : `${rest} minutes`
  return `${hourLabel} ${minuteLabel}`
}

export const formatProviderRecoveryElapsed = (elapsedMs: number): string => {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000))
  if (minutes < 1) {
    return "less than a minute"
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourLabel = hours === 1 ? "1 hour" : `${hours} hours`
  if (rest === 0) {
    return hourLabel
  }
  const minuteLabel = rest === 1 ? "1 minute" : `${rest} minutes`
  return `${hourLabel} ${minuteLabel}`
}

export const formatProviderRecoveryModel = (
  episode: Pick<
    ProviderRecoverySnapshot,
    "providerId" | "providerLabel" | "model"
  >,
): string | null => {
  const provider = episode.providerLabel ?? episode.providerId
  if (provider !== null && episode.model !== null) {
    return `${provider} · ${episode.model}`
  }
  return episode.model ?? provider
}

export const formatProviderRecoveryWaitingHeadline = (input: {
  readonly episode: ProviderRecoverySnapshot
  readonly nowMs: number
}): string => {
  const remaining =
    input.episode.nextAttemptAt === null
      ? 0
      : input.episode.nextAttemptAt - input.nowMs
  return `${providerRecoveryCauseLabel(input.episode)} — retrying in ${formatProviderRecoveryCountdown(remaining)}`
}

/**
 * Stable API sentence. The live countdown is derived in the UI from
 * nextAttemptAt so a reloaded page does not trust a stale minute count.
 */
export const formatProviderRecoveryApiMessage = (
  episode: ProviderRecoverySnapshot,
): string | null => {
  if (episode.status === "exhausted") {
    return PROVIDER_RECOVERY_EXHAUSTED_MESSAGE
  }
  if (episode.status !== "scheduled") {
    return null
  }
  const model = formatProviderRecoveryModel(episode)
  const next =
    episode.nextAttemptAt === null
      ? "the next admission"
      : new Date(episode.nextAttemptAt).toISOString()
  const attempts =
    episode.attemptCount === 1
      ? "1 failed attempt"
      : `${episode.attemptCount} failed attempts`
  const modelSuffix = model === null ? "" : ` ${model}.`
  return `${providerRecoveryCauseLabel(episode)} — next attempt at ${next}.${modelSuffix} ${attempts}.`
}

export const parseProviderRecoveryMaxWaitMinutes = (
  mode: "unlimited" | "limited",
  minutes: string,
):
  | { readonly ok: true; readonly maxWaitMs: number | null }
  | { readonly ok: false; readonly message: string } => {
  if (mode === "unlimited") {
    return { ok: true, maxWaitMs: null }
  }
  const trimmed = minutes.trim()
  if (trimmed.length === 0) {
    return {
      ok: false,
      message: "Enter a positive number of minutes, or choose Keep retrying.",
    }
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: "Maximum wait must be a positive whole number of minutes.",
    }
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      ok: false,
      message: "Maximum wait must be a positive whole number of minutes.",
    }
  }
  const maxWaitMs = parsed * 60_000
  if (!Number.isSafeInteger(maxWaitMs)) {
    return {
      ok: false,
      message: "Maximum wait is too large.",
    }
  }
  return { ok: true, maxWaitMs }
}
