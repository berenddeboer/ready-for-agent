import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { repositoriesQuery } from "../repositories-query.js"
import {
  statisticsControl as control,
  statisticsKicker as kicker,
} from "../statistics-charts.js"
import {
  UNKNOWN_MODEL_FILTER,
  backendSelectOptions,
  currentModelSelectValue,
  modelSelectOptions,
  parseModelFilterValue,
  parseStatisticsAgentBackend,
  parseStatisticsModel,
  statisticsExplorerKey,
} from "../statistics-filters.js"
import { type TimingTask, projectTimingTask } from "../statistics-model.js"
import { timingHistoryQuery } from "../statistics-query.js"
import { StatisticsTaskDialog } from "../statistics-task-dialog.js"
import {
  TimingExplorer,
  TimingOverview,
  TimingRepeats,
  TimingSteps,
} from "../statistics-views.js"
import {
  type StatisticsWindow,
  parseStatisticsWindow,
  statisticsWindows,
} from "../statistics-window.js"

type StatisticsSearch = {
  view: "overview" | "tasks" | "repeats" | "steps"
  lane: "build" | "review" | "pr"
  window: StatisticsWindow
  repository: string
  agentBackend: string
  model: string
  step: string
}

export const Route = createFileRoute("/statistics")({
  validateSearch: (raw: Record<string, unknown>): StatisticsSearch => ({
    view:
      raw.view === "tasks" || raw.view === "repeats" || raw.view === "steps"
        ? raw.view
        : "overview",
    lane: raw.lane === "review" || raw.lane === "pr" ? raw.lane : "build",
    window: parseStatisticsWindow(raw.window),
    repository: typeof raw.repository === "string" ? raw.repository : "",
    agentBackend: parseStatisticsAgentBackend(raw.agentBackend),
    model: parseStatisticsModel(raw.model),
    step:
      typeof raw.step === "string" && raw.step.length < 100
        ? raw.step
        : "pre_commit",
  }),
  component: StatisticsPage,
})

function StatisticsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [selected, setSelected] = useState<TimingTask | null>(null)
  const repositories = useQuery(repositoriesQuery)
  const query = useQuery(
    timingHistoryQuery({
      repositoryId: search.repository,
      window: search.window,
      agentBackend: search.agentBackend,
      model: search.model,
    }),
  )
  const tasks = useMemo(
    () => (query.data?.items ?? []).map(projectTimingTask),
    [query.data],
  )
  const backendOptions = backendSelectOptions({
    backends: query.data?.choices.agentBackends ?? [],
    selected: search.agentBackend,
  })
  const modelOptions = modelSelectOptions({
    choices: query.data?.choices.models ?? [],
    agentBackend: search.agentBackend,
    selectedModel: search.model,
  })
  const modelValue = currentModelSelectValue({
    model: search.model,
    agentBackend: search.agentBackend,
    options: modelOptions,
  })
  const update = (values: Partial<StatisticsSearch>) => {
    setSelected(null)
    void navigate({
      search: (prev) => ({ ...prev, ...values }),
      resetScroll: false,
    })
  }
  const onStep = (step: string) => update({ view: "steps", step })
  const missing = tasks.filter((task) => task.executionMs === null).length
  return (
    <main className="mx-auto max-w-[1500px] px-3 pb-12 pt-6 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className={kicker}>Performance / completed work</p>
          <h2 className="mt-2 text-4xl font-extrabold tracking-tight">
            Where does the time go?
          </h2>
          <p className="mt-2 text-ink-dim">
            Understand typical work, investigate outliers, and find repeated
            execution.
          </p>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-end gap-3 sm:w-auto">
          <label className="grid w-full min-w-0 gap-1 text-xs sm:w-auto">
            Repository
            <select
              className={`${control} w-full max-w-full sm:max-w-64`}
              name="repository"
              value={search.repository}
              onChange={(e) => update({ repository: e.target.value })}
            >
              <option value="">All repositories</option>
              {repositories.data?.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.projectPath}
                </option>
              ))}
              {search.repository &&
                !repositories.data?.some((r) => r.id === search.repository) && (
                  <option value={search.repository}>{search.repository}</option>
                )}
            </select>
          </label>
          <label className="grid w-full min-w-0 gap-1 text-xs sm:w-auto">
            Agent Backend
            <select
              className={`${control} w-full max-w-full sm:max-w-64`}
              name="agentBackend"
              value={search.agentBackend}
              onChange={(event) => update({ agentBackend: event.target.value })}
            >
              <option value="">All agent backends</option>
              {backendOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid w-full min-w-0 gap-1 text-xs sm:w-auto">
            Model
            <select
              className={`${control} w-full max-w-full sm:max-w-72`}
              name="model"
              value={modelValue}
              onChange={(event) => {
                const value = event.target.value
                if (value === "" || value === UNKNOWN_MODEL_FILTER) {
                  update({ model: value })
                  return
                }
                const parsed = parseModelFilterValue(value)
                update({
                  model: parsed.model,
                  ...(parsed.agentBackend === null
                    ? {}
                    : { agentBackend: parsed.agentBackend }),
                })
              }}
            >
              <option value="">All models</option>
              {(query.data?.choices.hasUnknownModel ||
                search.model === UNKNOWN_MODEL_FILTER) && (
                <option value={UNKNOWN_MODEL_FILTER}>Unknown model</option>
              )}
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid w-full min-w-0 gap-1 text-xs sm:w-auto">
            Completed within
            <select
              className={`${control} w-full max-w-full`}
              name="window"
              value={search.window}
              onChange={(e) =>
                update({ window: parseStatisticsWindow(e.target.value) })
              }
            >
              {statisticsWindows.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={control}
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch()
              void repositories.refetch()
            }}
          >
            Refresh
          </button>
        </div>
      </div>
      <div
        className="my-6 flex flex-wrap items-center justify-between gap-3 border-y border-line-soft py-3 text-sm"
        aria-live="polite"
      >
        <p>
          {query.isPending
            ? "Loading recorded timings…"
            : query.data
              ? `${tasks.length.toLocaleString()} Complete Work Items · all recorded attempts included`
              : "Timings unavailable"}
        </p>
        <span className="text-xs text-ink-dim">
          {query.isFetching
            ? "Updating…"
            : query.dataUpdatedAt
              ? `Updated ${new Date(query.dataUpdatedAt).toLocaleTimeString()}`
              : ""}
        </span>
      </div>
      <nav aria-label="Statistics views" className="mb-6 flex flex-wrap gap-2">
        {[
          { view: "overview", label: "Overview" },
          { view: "tasks", label: "Task explorer" },
          { view: "repeats", label: "Retry hotspots" },
          { view: "steps", label: "Step timings" },
        ].map(({ view, label }) => (
          <Route.Link
            key={view}
            search={(prev) => ({
              ...prev,
              view:
                view === "tasks" || view === "repeats" || view === "steps"
                  ? view
                  : "overview",
            })}
            resetScroll={false}
            className={`${control} ${search.view === view ? "border-ink font-bold" : ""}`}
            aria-current={search.view === view ? "page" : undefined}
          >
            {label}
          </Route.Link>
        ))}
      </nav>
      {query.isError && (
        <div role="alert" className="mb-5 border border-line-soft p-4">
          <p>
            Could not {query.data ? "refresh" : "load"} statistics.{" "}
            {query.data
              ? "The last successful snapshot is shown below."
              : "Try Refresh to load them again."}
          </p>
          <p className="mt-1 text-sm text-ink-dim">{query.error.message}</p>
        </div>
      )}
      {repositories.isError && (
        <p role="status" className="mb-4 text-sm text-ink-dim">
          Repository filters could not be refreshed. Statistics remain scoped to
          the selected repository.
        </p>
      )}
      {query.data && tasks.length === 0 && (
        <section className="border border-line-soft p-8">
          <h3 className="text-xl font-bold">
            No completed work in this selection
          </h3>
          <p className="mt-2 text-ink-dim">
            Change the repository, completion window, agent backend, or model.
            Failed, abandoned and unfinished Work Items are not included.
          </p>
        </section>
      )}
      {tasks.length > 0 && (
        <>
          {missing > 0 && (
            <p className="mb-5 border-l-4 border-signal pl-3 text-sm">
              {missing} {missing === 1 ? "task has" : "tasks have"} missing or
              incomplete execution timings. They remain in the explorer; unknown
              durations are excluded from averages and shown as —. Each lane and
              step displays its own sample count.
            </p>
          )}
          {search.view === "overview" && (
            <TimingOverview
              tasks={tasks}
              lane={search.lane}
              setLane={(lane) => update({ lane })}
              onSelect={setSelected}
              onStep={onStep}
            />
          )}
          {search.view === "tasks" && (
            <TimingExplorer
              key={statisticsExplorerKey(search)}
              tasks={tasks}
              onSelect={setSelected}
            />
          )}
          {search.view === "repeats" && (
            <TimingRepeats
              tasks={tasks}
              onSelect={setSelected}
              onStep={onStep}
            />
          )}
          {search.view === "steps" && (
            <TimingSteps
              tasks={tasks}
              step={search.step}
              onStep={onStep}
              onSelect={setSelected}
            />
          )}
        </>
      )}
      <details className="mt-7 border-t border-line-soft pt-4 text-sm text-ink-dim">
        <summary className="cursor-pointer font-semibold">
          How these statistics are calculated
        </summary>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <p>
            Only Work Items in Complete are included, filtered by their
            completion time. All their retained attempts are included, even
            those before the selected window. Failed, abandoned and unfinished
            tasks are excluded: these numbers describe completed work, not the
            success rate of all work.
          </p>
          <p>
            Execution sums recorded start-to-finish durations, including
            failed/interrupted attempts, internal fix loops, external waits
            inside a step, and Agent Turn slot waits. Elapsed is creation to
            Complete. Overlapping attempts can make summed execution exceed
            elapsed.
          </p>
          <p>
            Averages and percentiles use only complete timings for the selected
            lane or step. Missing or skipped steps are not zero-duration
            samples. The median is the middle observation; P90 uses linear
            interpolation. A task above the selected cohort’s total-execution
            P90 is a long-tail task.
          </p>
          <p>
            Repeats are extra started attempts of the same step. Watch polling,
            postponed and cancelled attempts do not count as repeats. Internal
            Review Fix Rounds and individual hook commands are not separately
            timed. Extra work is not automatically wasted work.
          </p>
          <p>
            Agent Backend and Model filter the completed cohort; they do not
            drop individual attempts. Backend is the backend captured when the
            Work Item was created. A model matches when it was recorded as used
            on at least one retained agent execution, including Build, Review,
            or a retry. A task that used two models matches either one, is
            counted once, and keeps every Step Run — including non-agent steps
            and attempts from before the completion window. Filtered totals
            describe completed work involving that model, not time that belongs
            only to that model.
          </p>
          <p>
            Unknown model means no historical model was recorded. Those tasks
            stay in All models. Missing history is not filled from today's
            settings or from an execution profile that was never recorded as
            used. Partial history can match a recorded model, but the task
            dialog says when that list is incomplete. Choices come from retained
            history for the repository and window, not from backends installed
            now. Thinking level is not a filter.
          </p>
        </div>
      </details>
      {selected && (
        <StatisticsTaskDialog
          task={selected}
          initialStep={search.view === "steps" ? search.step : ""}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  )
}
