import { useEffect, useRef, useState } from "react"
import { agentBackendLabel } from "@ready-for-agent/agent-backend"
import {
  StatisticsMetric,
  statisticsControl,
  statisticsKicker,
} from "./statistics-charts.js"
import { modelHistoryDisclosure } from "./statistics-filters.js"
import {
  type TimingTask,
  formatTime,
  stepLabel,
  timingLaneColors,
  timingLaneLabels,
  timingLanes,
} from "./statistics-model.js"

export function StatisticsTaskDialog({
  task,
  onClose,
  initialStep,
}: {
  task: TimingTask
  onClose: () => void
  initialStep: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState(initialStep)
  const details = task.details.filter(
    (attempt) => !step || attempt.step === step,
  )
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      onClose={(event) => {
        // StrictMode can close then reopen during effect replay. Ignore the
        // queued close event from that cleanup when the dialog is open again.
        if (!event.currentTarget.open) onClose()
      }}
      aria-labelledby="statistics-task-title"
      className="fixed inset-0 m-auto max-h-[85vh] w-[min(1000px,94vw)] overflow-auto border-2 border-ink bg-panel p-6 text-ink backdrop:bg-black/50"
    >
      <div className="flex items-start justify-between gap-5">
        <div>
          <p className={statisticsKicker}>
            {task.label} · {task.repository}
          </p>
          <h3 id="statistics-task-title" className="mt-2 text-2xl font-bold">
            {task.title}
          </h3>
          <p className="mt-2 text-xs text-ink-dim">
            Completed {new Date(task.completedAt).toLocaleString()} · {task.id}
          </p>
          <p className="mt-2 text-xs text-ink-dim">
            {agentBackendLabel(task.agentBackend)}
            {task.models.length > 0 ? ` · ${task.models.join(", ")}` : ""}
          </p>
          <p className="mt-2 max-w-xl text-xs text-ink-dim">
            {modelHistoryDisclosure({
              history: task.modelHistory,
              models: task.models,
            })}
          </p>
        </div>
        <button
          type="button"
          className={statisticsControl}
          onClick={() => ref.current?.close()}
        >
          Close
        </button>
      </div>
      <div className="my-6 grid grid-cols-2 gap-5 lg:grid-cols-4">
        <StatisticsMetric
          label="Execution"
          value={formatTime(task.executionMs)}
          note={
            task.missing
              ? `${task.missing} attempts have missing timings`
              : "All recorded attempts"
          }
        />
        <StatisticsMetric
          label="Elapsed"
          value={formatTime(task.elapsedMs)}
          note="Created → Complete"
        />
        <StatisticsMetric
          label="Step queueing"
          value={formatTime(task.queueMs)}
          note="Sum of recorded queued → started waits"
        />
        <StatisticsMetric
          label="Agent-slot waits"
          value={formatTime(task.sessionWaitMs)}
          note="Already included in execution"
        />
      </div>
      <h4 className="font-bold">Execution by lane</h4>
      <div className="my-4 grid gap-4">
        {timingLanes.map((lane) => {
          const row = task.lanes[lane]
          return (
            <div key={lane}>
              <div className="mb-2 flex flex-wrap justify-between gap-2 text-sm">
                <strong>{timingLaneLabels[lane]}</strong>
                <span className="font-mono">
                  {formatTime(row.executionMs)} · {row.repeats} extra attempts
                </span>
              </div>
              <div
                className="flex h-5"
                style={{
                  width: `${(row.recordedMs / Math.max(1, task.recordedMs)) * 100}%`,
                  background: timingLaneColors[lane],
                }}
              >
                <div
                  style={{
                    width: `${((row.recordedMs - row.repeatMs) / Math.max(1, row.recordedMs)) * 100}%`,
                  }}
                />
                <div
                  className="h-full flex-1"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(135deg, transparent, transparent 4px, #ffffff88 4px, #ffffff88 6px)",
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-xs text-ink-dim">
        Hatched: extra execution attempts. Missing timings are not treated as
        zero. These bars show recorded time only.
      </p>
      <div className="mb-3 mt-6 flex flex-wrap items-end justify-between gap-3">
        <h4 className="font-bold">
          Recorded attempts · {details.length} of {task.details.length}
        </h4>
        <label className="grid gap-1 text-xs">
          Step filter
          <select
            className={statisticsControl}
            value={step}
            onChange={(event) => setStep(event.target.value)}
          >
            <option value="">All steps</option>
            {[...new Set(task.details.map((attempt) => attempt.step))].map(
              (name) => (
                <option key={name} value={name}>
                  {stepLabel(name)}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              {[
                "Step",
                "Outcome",
                "Started",
                "Execution",
                "Queue",
                "Reason",
              ].map((h) => (
                <th key={h} className="border-b border-ink p-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {details.map((attempt) => (
              <tr key={attempt.id} className="border-b border-line-ghost">
                <th className="p-2 font-medium">
                  {stepLabel(attempt.step)}
                  {attempt.repeat && (
                    <span className="block text-ink-dim">Extra attempt</span>
                  )}
                </th>
                <td className="p-2">{attempt.status}</td>
                <td className="whitespace-nowrap p-2">
                  {attempt.startedAt === null
                    ? "Not started"
                    : new Date(attempt.startedAt).toLocaleString()}
                </td>
                <td className="whitespace-nowrap p-2 font-mono">
                  {formatTime(attempt.duration)}
                </td>
                <td className="whitespace-nowrap p-2 font-mono">
                  {formatTime(attempt.queue)}
                </td>
                <td className="max-w-60 break-words p-2">
                  {attempt.reasonCode ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-5 text-xs text-ink-dim">
        Execution is summed start-to-finish time, including internal waits and
        fix loops. Queueing does not include all Worker Slot holds, pauses or
        human attention. Historical data does not support a reliable split of
        all elapsed time into those categories.
      </p>
    </dialog>
  )
}
