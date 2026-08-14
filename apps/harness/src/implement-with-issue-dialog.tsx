import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { AgentModelOption } from "./agent-model-settings.js"
import {
  type ExecutionProfileDraft,
  type ExecutionProfilePrefSource,
  type ImplementWithProfileInput,
  resolveExecutionProfileDraft,
  usablePreviewCatalog,
} from "./execution-profile-draft.js"
import { createHarnessGraphqlClient } from "./harness-graphql.js"
import {
  ImplementWithDialog,
  ImplementWithModalDialog,
} from "./implement-with-dialog.js"
import { ui } from "./ui.js"

const graphql = createHarnessGraphqlClient({ batch: true })

const agentBackendsQuery = {
  queryKey: ["agentBackends"] as const,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({
      agentBackends: { id: true, label: true, configurationMode: true },
    })
    return result.agentBackends
  },
}

export type ImplementWithIssueDialogProps = {
  readonly issueNumber: number
  readonly backendId: string
  readonly repositoryPrefs: ExecutionProfilePrefSource
  readonly submitPending: boolean
  readonly submitError: string | null
  readonly onSubmit: (profile: ImplementWithProfileInput) => void
  readonly onCancel: () => void
}

/**
 * Loads Effective Agent Backend catalog and Harness prefs, then hosts the
 * ephemeral Implement With dialog. Does not mutate settings.
 */
export function ImplementWithIssueDialog({
  issueNumber,
  backendId,
  repositoryPrefs,
  submitPending,
  submitError,
  onSubmit,
  onCancel,
}: ImplementWithIssueDialogProps): ReactNode {
  const agentBackends = useQuery(agentBackendsQuery)
  const harnessPrefs = useQuery({
    queryKey: ["implement-with", "harness-prefs", backendId] as const,
    queryFn: async (): Promise<ExecutionProfilePrefSource> => {
      const result = await graphql.query({
        harnessModelPrefs: {
          __args: { backendId },
          defaultModel: true,
          defaultThinkingLevel: true,
          reviewModel: true,
          reviewThinkingLevel: true,
        },
      })
      return result.harnessModelPrefs
    },
  })
  const preview = useQuery({
    queryKey: ["implement-with", "preview", backendId] as const,
    queryFn: async () => {
      const result = await graphql.query({
        previewAgentBackend: {
          __args: { backendId },
          backend: { id: true, label: true },
          kind: true,
          reason: true,
          models: {
            id: true,
            thinkingLevels: true,
            name: true,
            kind: true,
          },
          warnings: true,
        },
      })
      return result.previewAgentBackend
    },
  })

  const backend = (agentBackends.data ?? []).find(
    (candidate) => candidate.id === backendId,
  )
  const backendLabel =
    preview.data?.backend.label ?? backend?.label ?? backendId
  const configurationMode = backend?.configurationMode ?? null
  const mappedPreview =
    preview.data === undefined
      ? undefined
      : {
          kind: preview.data.kind,
          models: preview.data.models.map(
            (model): AgentModelOption => ({
              id: model.id,
              thinkingLevels: model.thinkingLevels,
              name: model.name,
              kind: model.kind,
            }),
          ),
        }
  const usableCatalog = usablePreviewCatalog({
    preview: mappedPreview,
    previewFailed: preview.isError,
  })
  const catalogFailed = usableCatalog.failed
  const catalogError = catalogFailed
    ? preview.isError
      ? preview.error instanceof Error
        ? preview.error.message
        : "Could not load the Agent Model catalog."
      : (preview.data?.reason ?? "Could not load the Agent Model catalog.")
    : null
  const catalog = {
    loading: preview.isPending && usableCatalog.models === undefined,
    failed: catalogFailed,
    error: catalogError,
    models: usableCatalog.models,
    warnings: preview.data?.warnings ?? [],
  }

  if (harnessPrefs.isPending) {
    const loadingTitleId = `implement-with-loading-${issueNumber}`
    return (
      <ImplementWithModalDialog labelledBy={loadingTitleId} onCancel={onCancel}>
        <div className={ui.dialogHeader}>
          <p className={ui.dialogKicker}>Implement With</p>
          <h2 id={loadingTitleId} className={ui.dialogTitle}>
            Implement issue #{issueNumber} with...
          </h2>
          <p className={ui.dialogLede}>
            These choices apply only to this Work Item. They never change
            Repository settings or Harness Config.
          </p>
        </div>
        <div className={ui.dialogBody}>
          <p className={ui.dialogLoading}>Loading current preferences...</p>
        </div>
        <div className={ui.dialogFooter}>
          <button type="button" className={ui.plateMini} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </ImplementWithModalDialog>
    )
  }

  const harness: ExecutionProfilePrefSource = harnessPrefs.data ?? {
    defaultModel: null,
    defaultThinkingLevel: null,
    reviewModel: null,
    reviewThinkingLevel: null,
  }
  const initialDraft: ExecutionProfileDraft = resolveExecutionProfileDraft({
    repository: repositoryPrefs,
    harness,
  })
  const prefsError = harnessPrefs.isError
    ? harnessPrefs.error instanceof Error
      ? harnessPrefs.error.message
      : "Could not load Harness model preferences for this Agent Backend."
    : null

  return (
    <ImplementWithDialog
      issueNumber={issueNumber}
      backendId={backendId}
      backendLabel={backendLabel}
      configurationMode={configurationMode}
      initialDraft={initialDraft}
      catalog={catalog}
      prefsError={prefsError}
      submitPending={submitPending}
      submitError={submitError}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )
}
