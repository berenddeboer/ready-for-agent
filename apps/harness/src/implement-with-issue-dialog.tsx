import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useRef, useState } from "react"
import type { AgentModelOption } from "./agent-model-settings.js"
import {
  type ExecutionProfileDraft,
  type ExecutionProfilePrefSource,
  type ImplementWithCatalogPin,
  type ImplementWithSubmitInput,
  implementWithSessionPreview,
  nextImplementWithCatalogPin,
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
  readonly repositoryId: string
  readonly initialBackendId: string
  readonly repositoryPrefs: ExecutionProfilePrefSource
  readonly initialMergePolicy: "OFF" | "CLASSIFY" | "ALWAYS"
  readonly submitPending: boolean
  readonly submitError: string | null
  readonly onSubmit: (input: ImplementWithSubmitInput) => void
  readonly onCancel: () => void
}

/**
 * Loads shipped Agent Backend catalogs and resolved prefs, then hosts the
 * ephemeral Implement With dialog. Preview and pref reads do not mutate
 * settings or the Active set.
 */
export function ImplementWithIssueDialog({
  issueNumber,
  repositoryId,
  initialBackendId,
  repositoryPrefs,
  initialMergePolicy,
  submitPending,
  submitError,
  onSubmit,
  onCancel,
}: ImplementWithIssueDialogProps): ReactNode {
  const [backendId, setBackendId] = useState(initialBackendId)
  const catalogPinsRef = useRef<
    Readonly<Record<string, ImplementWithCatalogPin>>
  >({})
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
  const repositoryScopedPrefs = useQuery({
    queryKey: [
      "implement-with",
      "repository-prefs",
      repositoryId,
      backendId,
    ] as const,
    queryFn: async (): Promise<ExecutionProfilePrefSource> => {
      const result = await graphql.query({
        repositoryModelPrefs: {
          __args: { repositoryId, backendId },
          defaultModel: true,
          defaultThinkingLevel: true,
          reviewModel: true,
          reviewThinkingLevel: true,
        },
      })
      return result.repositoryModelPrefs
    },
  })
  const preview = useQuery({
    queryKey: ["implement-with", "preview", backendId] as const,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
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

  const backends = agentBackends.data ?? []
  const backend = backends.find((candidate) => candidate.id === backendId)
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
  const existingPin = catalogPinsRef.current[backendId]
  const sessionPreview = implementWithSessionPreview({
    pin: existingPin,
    preview: mappedPreview,
    fetchedAfterMount: preview.isFetchedAfterMount,
    previewFailed: preview.isError,
  })
  const catalogPin = nextImplementWithCatalogPin({
    pin: existingPin,
    preview: sessionPreview.preview,
  })
  if (
    catalogPin !== undefined &&
    catalogPinsRef.current[backendId] === undefined
  ) {
    catalogPinsRef.current = {
      ...catalogPinsRef.current,
      [backendId]: catalogPin,
    }
  }
  const usableCatalog = usablePreviewCatalog({
    preview: sessionPreview.preview,
    previewFailed: sessionPreview.previewFailed,
    pin: catalogPin,
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
    loading: usableCatalog.models === undefined && !catalogFailed,
    failed: catalogFailed,
    error: catalogError,
    models: usableCatalog.models,
    warnings: preview.data?.warnings ?? [],
  }

  const firstPrefsPending =
    backendId === initialBackendId &&
    harnessPrefs.isPending &&
    harnessPrefs.data === undefined
  if (firstPrefsPending) {
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

  const emptyPrefs: ExecutionProfilePrefSource = {
    defaultModel: null,
    defaultThinkingLevel: null,
    reviewModel: null,
    reviewThinkingLevel: null,
  }
  const harness: ExecutionProfilePrefSource = harnessPrefs.data ?? emptyPrefs
  const repositoryForBackend =
    backendId === initialBackendId
      ? repositoryPrefs
      : (repositoryScopedPrefs.data ?? emptyPrefs)
  const initialDraft: ExecutionProfileDraft = resolveExecutionProfileDraft({
    repository: repositoryForBackend,
    harness,
  })
  const prefsError = harnessPrefs.isError
    ? harnessPrefs.error instanceof Error
      ? harnessPrefs.error.message
      : "Could not load Harness model preferences for this Agent Backend."
    : repositoryScopedPrefs.isError
      ? repositoryScopedPrefs.error instanceof Error
        ? repositoryScopedPrefs.error.message
        : "Could not load Repository model preferences for this Agent Backend."
      : null

  return (
    <ImplementWithDialog
      issueNumber={issueNumber}
      backendId={backendId}
      backends={
        backends.length > 0 ? backends : [{ id: backendId, label: backendId }]
      }
      configurationMode={configurationMode}
      initialDraft={initialDraft}
      catalog={catalog}
      prefsError={prefsError}
      initialMergePolicy={initialMergePolicy}
      submitPending={submitPending}
      submitError={submitError}
      onSubmit={onSubmit}
      onBackendChange={setBackendId}
      onCancel={onCancel}
    />
  )
}
