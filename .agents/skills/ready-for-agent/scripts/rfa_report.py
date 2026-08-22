#!/usr/bin/env python3
"""Detailed progress report for a running Ready for Agent harness.

One GraphQL round trip per section, then a dense operator-readable report:
lane occupancy, per-work-item lifecycle timing, stall detection, blocked
reasons, and throughput.

Usage:
  rfa_report.py                         # every repository
  rfa_report.py --repo acme-web         # one repository (substring of project path)
  rfa_report.py --issue 412             # one issue, including items hidden from listings
  rfa_report.py --json                  # machine-readable
  rfa_report.py --endpoint http://127.0.0.1:7000/graphql
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_ENDPOINT = os.environ.get(
    "READY_FOR_AGENT_GRAPHQL_URL", "http://127.0.0.1:6056/graphql"
)

# Steps that run an agent turn; these legitimately take many minutes, so the
# stall thresholds below are deliberately generous for them.
AGENT_STEPS = {"IMPLEMENT", "REVIEW", "COMMIT", "DECIDE_PR_MERGE",
               "INVESTIGATE_PR_STATUS_CHECKS", "RESOLVE_PR_MERGE_CONFLICT"}
AGENT_STALL_MS = 90 * 60 * 1000      # 90 min inside an agent step
OTHER_STALL_MS = 10 * 60 * 1000      # 10 min inside a mechanical step

# Repository merge configuration changed shape between releases: older harnesses
# expose `autoMerge: Boolean`, current ones a three-state `mergePolicy`. Probe
# once and build the query around whichever this harness actually serves, so the
# report works across versions instead of failing validation on one of them.
MERGE_FIELD_MODERN = "mergePolicy"
MERGE_FIELD_LEGACY = "autoMerge"

KANBAN_QUERY = """
{
  config {
    selectedAgentBackend maxConcurrentAgentTurns maxConcurrentWorkItems
    unfinishedWorkItemCount blockingUnfinishedWorkItemCount
  }
  repositories {
    id projectPath forgeHost localPath paused __MERGE_FIELD__
    effectiveAgentBackend defaultModel defaultThinkingLevel reviewModel
    includeAllIssueAuthors issuesReconciledAt
    blockingUnfinishedWorkItemCount
  }
  agentBackendStatuses { kind reason backend { id label } }
  kanbanStatus {
    lanes {
      id label count
      workItems {
        repository { id projectPath }
        workItem {
          id issueNumber issueTitle state stateLabel status statusLabel
          statusMessage canRetry isTerminal paused pullRequestNumber
          sessionId worktreePath stateResidenceMs mergeMode failureCode
          createdAt updatedAt
          agentBackend { id label }
          lifecycleLabels { phase label status durationMs }
          latestStepRunReason { code message retryAt }
        }
      }
    }
  }
}
"""

ISSUE_QUERY = """
query ($repositoryId: ID!, $issueNumber: Int!) {
  workItems(repositoryId: $repositoryId, issueNumber: $issueNumber) {
    id issueNumber issueTitle state stateLabel status statusLabel
    statusMessage canRetry isTerminal paused pullRequestNumber
    sessionId worktreePath stateResidenceMs mergeMode failureCode
    createdAt updatedAt
    agentBackend { id label }
    lifecycleLabels { phase label status durationMs }
    latestStepRunReason { code message retryAt }
  }
}
"""

# `pullRequestCount` is `Int!` and reaches the Forge API, so when that call
# fails the non-null propagates and nulls the WHOLE query — one rate-limited
# lookup would otherwise cost the entire progress report. Fetch it on its own
# and treat failure as "unknown".
PR_COUNT_QUERY = """
{ repositories { id pullRequestCount } }
"""

THROUGHPUT_QUERY = """
query ($from: String!, $to: String!) {
  committedPullRequestsCount(from: $from, to: $to)
  completedWorkItems(page: 1, pageSize: 10) {
    totalCount
    items { id issueNumber issueTitle state pullRequestNumber updatedAt }
  }
}
"""


def gql(endpoint: str, query: str, variables: dict | None = None) -> dict:
    payload = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        endpoint, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
    except urllib.error.URLError as exc:
        sys.exit(
            f"Cannot reach the harness at {endpoint}: {exc}\n"
            "Is `ready-for-agent` running? Start it with `ready-for-agent --no-open`."
        )
    errors = body.get("errors")
    data = body.get("data")
    if errors and data is None:
        sys.exit("GraphQL errors:\n" + json.dumps(errors, indent=2))
    if errors:
        # Field-level failures are routine: `pullRequestCount` reaches the Forge
        # API and dies on rate limits, auth, or a network blip. GraphQL still
        # returns every field that resolved, so report the gap and keep going
        # rather than discarding a whole progress report over one nullable field.
        for err in errors:
            path = ".".join(str(p) for p in err.get("path") or []) or "query"
            print(f"  ! partial data — {path}: {err.get('message')}", file=sys.stderr)
    return data


def fetch_pr_counts(endpoint: str) -> dict[str, int]:
    """Best-effort open-PR counts, keyed by repository id; {} when the Forge call fails."""
    payload = json.dumps({"query": PR_COUNT_QUERY}).encode()
    req = urllib.request.Request(
        endpoint, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
        repos = (body.get("data") or {}).get("repositories") or []
        return {r["id"]: r["pullRequestCount"] for r in repos}
    except Exception:
        return {}


def detect_merge_field(endpoint: str) -> str:
    """Return whichever Repository merge field this harness serves."""
    data = gql(endpoint,
               '{ __type(name: "Repository") { fields { name } } }')
    names = {f["name"] for f in (data["__type"] or {}).get("fields", [])}
    return MERGE_FIELD_MODERN if MERGE_FIELD_MODERN in names else MERGE_FIELD_LEGACY


def render_merge(repo: dict, field: str) -> str:
    value = repo.get(field)
    if field == MERGE_FIELD_MODERN:
        return str(value).lower() if value else "unknown"
    return "always" if value else "off/classify"


def human_ms(ms) -> str:
    if ms is None:
        return "-"
    s = ms / 1000.0
    if s < 60:
        return f"{s:.0f}s"
    m = s / 60.0
    if m < 60:
        return f"{m:.0f}m"
    return f"{m / 60.0:.1f}h"


def age_ms(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds() * 1000


def stall_note(wi: dict) -> str | None:
    """Flag work that has sat in one state longer than its step warrants."""
    if wi["status"] != "RUNNING":
        return None
    resident = wi.get("stateResidenceMs")
    if resident is None:
        return None
    limit = AGENT_STALL_MS if wi["state"] in AGENT_STEPS else OTHER_STALL_MS
    if resident > limit:
        return f"STALL? {human_ms(resident)} in {wi['state']}"
    return None


def chip_line(labels: list[dict]) -> str:
    mark = {"SUCCEEDED": "OK", "RUNNING": ">>", "FAILED": "XX",
            "NEEDS_HUMAN": "!!", "QUEUED": "..", "INTERRUPTED": "--"}
    return "  ".join(
        f"{c['phase']}[{mark.get(c['status'], c['status'][:2])}"
        f"{'/' + human_ms(c['durationMs']) if c['durationMs'] else ''}]"
        for c in labels
    )


def render_work_item(wi: dict, repo_label: str | None, indent: str = "   ") -> list[str]:
    out = []
    head = f"{indent}#{wi['issueNumber']} {wi['state']}/{wi['status']}"
    if repo_label:
        head += f"  [{repo_label}]"
    flags = []
    if wi.get("paused"):
        flags.append("PAUSED")
    if wi.get("canRetry"):
        flags.append("retryable")
    if wi.get("pullRequestNumber"):
        flags.append(f"PR#{wi['pullRequestNumber']}")
    if wi.get("failureCode"):
        flags.append(f"failure={wi['failureCode']}")
    if flags:
        head += "  (" + ", ".join(flags) + ")"
    out.append(head)
    out.append(f"{indent}  {(wi.get('issueTitle') or '')[:100]}")

    stall = stall_note(wi)
    if stall:
        out.append(f"{indent}  ** {stall}")
    if wi.get("stateResidenceMs") is not None:
        out.append(f"{indent}  in state: {human_ms(wi['stateResidenceMs'])}")
    if wi.get("lifecycleLabels"):
        out.append(f"{indent}  {chip_line(wi['lifecycleLabels'])}")
    if wi.get("statusMessage"):
        out.append(f"{indent}  message: {wi['statusMessage'][:200]}")
    reason = wi.get("latestStepRunReason") or {}
    if reason.get("code"):
        out.append(f"{indent}  reason[{reason['code']}]: {(reason.get('message') or '')[:160]}")
        if reason.get("retryAt"):
            out.append(f"{indent}  retryAt: {reason['retryAt']}")
    if wi.get("sessionId"):
        out.append(f"{indent}  session: {wi['sessionId']}  worktree: {wi.get('worktreePath') or '-'}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    ap.add_argument("--repo", help="substring match on project path, e.g. 'acme-web'")
    ap.add_argument("--issue", type=int,
                    help="report one issue, including items hidden from repo-wide listings")
    ap.add_argument("--json", action="store_true", dest="as_json")
    ap.add_argument("--throughput", action="store_true",
                    help="include merged-PR counts and the completed archive")
    args = ap.parse_args()

    merge_field = detect_merge_field(args.endpoint)
    pr_counts = fetch_pr_counts(args.endpoint)
    data = gql(args.endpoint,
               KANBAN_QUERY.replace("__MERGE_FIELD__", merge_field))
    repos = data["repositories"]

    def repo_match(path: str) -> bool:
        return not args.repo or args.repo.lower() in path.lower()

    selected = [r for r in repos if repo_match(r["projectPath"])]
    if args.repo and not selected:
        sys.exit(f"No configured repository matches {args.repo!r}. "
                 f"Configured: {', '.join(r['projectPath'] for r in repos) or '(none)'}")

    # Single-issue mode bypasses the kanban window entirely: a terminal-failed
    # Work Item whose Issue left the relevant set is invisible to repo-wide
    # listings but still answers a direct issueNumber query.
    if args.issue is not None:
        if len(selected) != 1:
            sys.exit("--issue needs exactly one repository; narrow it with --repo")
        repo = selected[0]
        items = gql(args.endpoint, ISSUE_QUERY,
                    {"repositoryId": repo["id"], "issueNumber": args.issue})["workItems"]
        if args.as_json:
            print(json.dumps({"repository": repo, "workItems": items}, indent=2))
            return
        print(f"Issue #{args.issue} in {repo['projectPath']} — {len(items)} work item(s)\n")
        for wi in items:
            print("\n".join(render_work_item(wi, None, indent="  ")))
            print()
        if not items:
            print("  No Work Item exists for this issue "
                  "(never started, or Reset erased it).")
        return

    if args.as_json:
        print(json.dumps(data, indent=2))
        return

    cfg = data["config"]
    selected_ids = {r["id"] for r in selected}

    print("=" * 78)
    print("READY FOR AGENT — PROGRESS REPORT")
    print("=" * 78)
    print(f"backend: {cfg['selectedAgentBackend']}   "
          f"slots: {cfg['unfinishedWorkItemCount']}/{cfg['maxConcurrentWorkItems']} work items, "
          f"max {cfg['maxConcurrentAgentTurns']} concurrent agent turns")

    for st in data["agentBackendStatuses"]:
        if st["kind"] != "READY":
            print(f"  ! backend {st['backend']['label']}: {st['kind']} "
                  f"{st.get('reason') or ''}")

    print("\nRepositories")
    for r in selected:
        recon = age_ms(r["issuesReconciledAt"])
        print(f"  {r['projectPath']} ({r['forgeHost']})"
              f"  merge={render_merge(r, merge_field)}"
              f"{'  PAUSED' if r['paused'] else ''}")
        print(f"    agent={r['effectiveAgentBackend']} "
              f"model={r['defaultModel'] or 'inherit'}"
              f"/{r['defaultThinkingLevel'] or '-'}"
              f"  review={r['reviewModel'] or 'same as build'}")
        print(f"    blocking unfinished={r['blockingUnfinishedWorkItemCount']}"
              f"  open PRs on forge={pr_counts.get(r['id'], '?')}"
              f"  issues reconciled {human_ms(recon)} ago"
              f"{'  (STALE)' if recon and recon > 30 * 60 * 1000 else ''}")

    print("\nPipeline")
    attention = []
    for lane in data["kanbanStatus"]["lanes"]:
        rows = [kw for kw in lane["workItems"]
                if kw["repository"]["id"] in selected_ids]
        print(f"\n[{lane['id']:9}] {len(rows)}")
        if not rows:
            print("   lane clear")
            continue
        for kw in rows:
            wi = kw["workItem"]
            label = kw["repository"]["projectPath"] if len(selected) > 1 else None
            print("\n".join(render_work_item(wi, label)))
            if lane["id"] == "ATTENTION":
                attention.append((kw["repository"]["projectPath"], wi))

    if attention:
        print("\n" + "=" * 78)
        print(f"NEEDS ATTENTION — {len(attention)} item(s)")
        print("=" * 78)
        for path, wi in attention:
            action = ("Retry" if wi["canRetry"]
                      else "Start" if wi["paused"]
                      else "Reset (erases the attempt) or resolve on the forge")
            print(f"  {path}#{wi['issueNumber']}: {wi['state']} -> {action}")
            if wi.get("statusMessage"):
                print(f"     {wi['statusMessage'][:160]}")

    if args.throughput:
        now = datetime.now(timezone.utc)
        frm = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        tp = gql(args.endpoint, THROUGHPUT_QUERY,
                 {"from": frm.isoformat().replace("+00:00", "Z"),
                  "to": now.isoformat().replace("+00:00", "Z")})
        print("\n" + "=" * 78)
        print("THROUGHPUT")
        print("=" * 78)
        print(f"  merged PRs since {frm:%Y-%m-%d}: {tp['committedPullRequestsCount']}")
        print(f"  completed work items (all time): {tp['completedWorkItems']['totalCount']}")
        for it in tp["completedWorkItems"]["items"][:10]:
            print(f"    #{it['issueNumber']:>5} {it['state']:9} "
                  f"PR#{it['pullRequestNumber'] or '-':<6} {it['updatedAt'][:16]}  "
                  f"{(it['issueTitle'] or '')[:60]}")


if __name__ == "__main__":
    main()
