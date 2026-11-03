import type { CiGateDefinitionObservationRecord } from "@ready-for-agent/db-service"
import {
  type CiGateHistoricalCoverage,
  type CiGateHistoryBound,
  ciGateCoverageFromCheckpoint,
  ciGateOrderKeyFromIdentity,
} from "@ready-for-agent/forge-contract"

const bound = (
  runIdentity: string | null | undefined,
  orderKey: string | null | undefined,
  createdAt: Date | null | undefined,
): CiGateHistoryBound | null => {
  const identity = runIdentity?.trim() ?? ""
  if (identity === "") {
    return null
  }
  const key =
    orderKey !== null && orderKey !== undefined && orderKey.trim() !== ""
      ? orderKey
      : ciGateOrderKeyFromIdentity(identity)
  if (key === null || createdAt === null || createdAt === undefined) {
    return null
  }
  return { runIdentity: identity, orderKey: key, createdAt }
}

const decodePending = (
  value: string | null | undefined,
): readonly CiGateHistoryBound[] => {
  if (value === null || value === undefined || value.trim() === "") {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }
    const bounds: CiGateHistoryBound[] = []
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) {
        continue
      }
      const record = entry as {
        readonly runIdentity?: unknown
        readonly orderKey?: unknown
        readonly createdAt?: unknown
      }
      if (
        typeof record.runIdentity !== "string" ||
        typeof record.orderKey !== "string" ||
        typeof record.createdAt !== "string"
      ) {
        continue
      }
      const createdAt = new Date(record.createdAt)
      if (Number.isNaN(createdAt.getTime())) {
        continue
      }
      bounds.push({
        runIdentity: record.runIdentity,
        orderKey: record.orderKey,
        createdAt,
      })
    }
    return bounds
  } catch {
    return []
  }
}

const encodePending = (bounds: readonly CiGateHistoryBound[]): string | null =>
  bounds.length === 0
    ? null
    : JSON.stringify(
        bounds.map((entry) => ({
          runIdentity: entry.runIdentity,
          orderKey: entry.orderKey,
          createdAt: entry.createdAt.toISOString(),
        })),
      )

export const historicalCoverageFromRecord = (
  record: CiGateDefinitionObservationRecord | undefined,
  branch: string | null,
): CiGateHistoricalCoverage => {
  if (record === undefined || record.coverageState === undefined) {
    return ciGateCoverageFromCheckpoint({
      runIdentity: record?.lastRunIdentity ?? null,
      orderKey: record?.lastRunOrderKey ?? null,
      createdAt: record?.lastRunCreatedAt ?? null,
      branch,
    })
  }
  return {
    state: record.coverageState,
    branch: record.coverageBranch ?? branch,
    checkpoint: bound(
      record.coverageCheckpointRunIdentity,
      record.coverageCheckpointOrderKey,
      record.coverageCheckpointCreatedAt,
    ),
    gapUpper: bound(
      record.coverageGapUpperRunIdentity,
      record.coverageGapUpperOrderKey,
      record.coverageGapUpperCreatedAt,
    ),
    progress: bound(
      record.coverageProgressRunIdentity,
      record.coverageProgressOrderKey,
      record.coverageProgressCreatedAt,
    ),
    stop: bound(
      record.coverageStopRunIdentity,
      record.coverageStopOrderKey,
      record.coverageStopCreatedAt,
    ),
    headFloor: bound(
      record.coverageHeadFloorRunIdentity,
      record.coverageHeadFloorOrderKey,
      record.coverageHeadFloorCreatedAt,
    ),
    pagesProcessed: record.coveragePagesProcessed ?? 0,
    diagnostic: record.coverageDiagnostic ?? null,
    pendingRuns: decodePending(record.coveragePendingRuns),
  }
}

export const withHistoricalCoverage = (
  record: CiGateDefinitionObservationRecord,
  coverage: CiGateHistoricalCoverage,
): CiGateDefinitionObservationRecord => ({
  ...record,
  coverageState: coverage.state,
  coverageBranch: coverage.branch,
  coverageCheckpointRunIdentity: coverage.checkpoint?.runIdentity ?? null,
  coverageCheckpointOrderKey: coverage.checkpoint?.orderKey ?? null,
  coverageCheckpointCreatedAt: coverage.checkpoint?.createdAt ?? null,
  coverageGapUpperRunIdentity: coverage.gapUpper?.runIdentity ?? null,
  coverageGapUpperOrderKey: coverage.gapUpper?.orderKey ?? null,
  coverageGapUpperCreatedAt: coverage.gapUpper?.createdAt ?? null,
  coverageProgressRunIdentity: coverage.progress?.runIdentity ?? null,
  coverageProgressOrderKey: coverage.progress?.orderKey ?? null,
  coverageProgressCreatedAt: coverage.progress?.createdAt ?? null,
  coverageStopRunIdentity: coverage.stop?.runIdentity ?? null,
  coverageStopOrderKey: coverage.stop?.orderKey ?? null,
  coverageStopCreatedAt: coverage.stop?.createdAt ?? null,
  coverageHeadFloorRunIdentity: coverage.headFloor?.runIdentity ?? null,
  coverageHeadFloorOrderKey: coverage.headFloor?.orderKey ?? null,
  coverageHeadFloorCreatedAt: coverage.headFloor?.createdAt ?? null,
  coveragePagesProcessed: coverage.pagesProcessed,
  coverageDiagnostic: coverage.diagnostic,
  coveragePendingRuns: encodePending(coverage.pendingRuns),
})
