import { Copy } from "./copy.js"
import type { Repository, WorkItem } from "./routes/index.js"
import { WorkItemLifecycleStatus, WorkItemPauseButton } from "./routes/index.js"
import { sessionWorktreeParts } from "./session-worktree-line.js"
import { workItemIssueUrl } from "./work-item-issue-url.js"
import { workItemPullRequestUrl } from "./work-item-pull-request-url.js"

export type CompletedWorkItemIssueLookup = {
  readonly title: string
  readonly url: string
}

/**
 * Completed Work Item list row shared by the Jobs Completed tab and the
 * historical Completed page (repository identity, issue link, agent/session,
 * lifecycle status, PR/outcome badges).
 */
export function CompletedWorkItemRow({
  workItem,
  repository,
  issue,
  onOpenSession,
}: {
  readonly workItem: WorkItem
  readonly repository: Repository | undefined
  readonly issue: CompletedWorkItemIssueLookup | undefined
  readonly onOpenSession: (workItemId: string, sessionId: string) => void
}) {
  const repositoryLabel =
    repository === undefined ? workItem.repositoryId : repository.projectPath
  const issueTitle = issue?.title ?? workItem.issueTitle ?? undefined
  const issueUrl =
    issue?.url !== undefined && issue.url !== ""
      ? issue.url
      : repository === undefined
        ? null
        : workItemIssueUrl(
            repository.forge,
            repository.forgeHost,
            repository.projectPath,
            workItem.issueNumber,
          )
  const issueIdentity =
    issueTitle === undefined
      ? `#${workItem.issueNumber}`
      : `#${workItem.issueNumber} · ${issueTitle}`
  const issueIdentityContent = (
    <>
      <span className="font-mono">#{workItem.issueNumber}</span>
      {issueTitle !== undefined && (
        <span className="font-serif"> · {issueTitle}</span>
      )}
    </>
  )
  const { sessionId, worktreePath } = sessionWorktreeParts(
    workItem.sessionId,
    workItem.worktreePath,
  )

  return (
    <li className="entry-rule min-w-0 px-1 py-2">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="m-0 truncate font-mono text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
            {repositoryLabel}
          </p>
          {issueUrl !== null && issueUrl !== "" ? (
            <a
              className="m-0 mt-0.5 block truncate text-sm font-semibold text-oxblood hover:underline"
              href={issueUrl}
              title={issueIdentity}
            >
              {issueIdentityContent}
            </a>
          ) : (
            <p
              className="m-0 mt-0.5 truncate text-sm font-semibold text-oxblood"
              title={issueIdentity}
            >
              {issueIdentityContent}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="stamp border-rule-2 text-ink-2">
            {workItem.stateLabel}
          </span>
          <WorkItemPauseButton workItem={workItem} />
        </div>
      </div>
      <p className="mt-1 mb-0 flex min-w-0 flex-wrap items-center gap-1">
        <span className="shrink-0 font-mono text-xs text-ink-faint">
          {workItem.agentBackend.label}
        </span>
        {(sessionId !== null || worktreePath !== null) && (
          <span className="shrink-0 font-mono text-xs text-ink-faint">-</span>
        )}
        {sessionId !== null && (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1">
            <button
              type="button"
              className="min-w-0 truncate font-mono text-xs text-ink-faint underline-offset-2 hover:text-oxblood hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
              title={sessionId}
              onClick={() => {
                onOpenSession(workItem.id, sessionId)
              }}
            >
              {sessionId}
            </button>
            <Copy value={sessionId} className="shrink-0" showValue={false} />
          </span>
        )}
        {sessionId !== null && worktreePath !== null && (
          <span className="shrink-0 font-mono text-xs text-ink-faint">-</span>
        )}
        {worktreePath !== null && (
          <Copy
            value={worktreePath}
            className="min-w-0 max-w-full"
            textClassName="font-mono text-xs text-ink-faint"
          />
        )}
      </p>
      <WorkItemLifecycleStatus
        workItem={workItem}
        compact
        issueUrl={issueUrl}
        pullRequestUrl={
          repository === undefined
            ? null
            : workItemPullRequestUrl(
                repository.forge,
                repository.forgeHost,
                repository.projectPath,
                workItem.pullRequestNumber,
              )
        }
      />
    </li>
  )
}
