---
status: accepted
---

# Configure issue tracking independently from repository hosting

The current Forge model couples issue tracking with git hosting and pull requests (ADR 0042), preventing Linear issues from driving work in a GitHub repository. Configure the issue tracker independently, initially delivering Linear with GitHub, rather than introducing a special-case combined platform. Adding a Repository automatically selects its hosting platform's default issue tracker, with no additional onboarding choice; users can change the tracker later in Repository settings.

## Agreed boundaries

- Each executable issue targets exactly one Repository. Cross-repository work is split into linked issues rather than coordinated as multiple repository deliveries under one issue.
- Linear support covers discovery, implementation, GitHub PR creation and monitoring, and completion in Linear, including successful no-code-change outcomes. Code review and CI remain on GitHub.
- The `ready-for-agent` label explicitly makes an issue eligible for agent work; ordinary workflow status alone does not grant that permission.
- Repository settings map a Linear project to the Repository. Only issues in that project are candidates, and each mapped project points to one Repository. Per-issue repository labels are not required.
- The harness ensures completion in Linear, including after a human merges the GitHub PR and when no code change is needed. Linear's native GitHub integration is optional; an already-completed issue is accepted rather than transitioned again.
- Changing a Repository's tracker affects future intake. Existing Work Items retain their original issue source and finish against it; historical issue links remain valid.
- Linear preserves the existing default of considering issues created by the authenticated operator, with an option to include all authors. Assignment does not substitute for authorship; the ready label remains required.
- Initial authentication uses a personal Linear API key through the existing credential-storage approach, independently of GitHub credentials.
- Choose the appropriate In Progress and Done statuses during Linear setup, accounting for team-specific workflows and suggesting suitable defaults. Move to In Progress when implementation starts, and Done after confirmed merge or successful no-change completion. Failure and human-attention requests use comments rather than requiring additional workflow statuses.
- A merged PR with an outstanding Linear close-out remains visibly pending overall completion. Retry only the outstanding tracker update, preserving the successful delivery and preventing duplicate implementation.
- Preserve the original issue and Repository association for existing Work Items. A changed display identifier does not create a new issue when the underlying identity is unchanged. Project moves do not require new coordination or intervention behavior for this integration.
- Execute leaf issues and honor Linear's native blockers, including readable blockers outside the mapped project. Unreadable blockers require attention rather than being treated as resolved. Automatic parent completion is outside the initial scope.
- Publish durable Linear milestones: work started, PR link, actionable human-attention requests, and a completion summary. Keep detailed execution logs and CI discussion in the harness and GitHub; retries reuse or update notifications instead of duplicating them.

## Consequences

Repository hosting identity must no longer implicitly determine issue identity or the destination for issue operations. ADR 0042's coupling between recorded issue numbers and Repository hosting identity must be revisited while preserving historical Work Item provenance. Tracker changes can leave a Repository with unfinished work from different issue sources, so operations and credentials must resolve against each Work Item's original source rather than only the Repository's current tracker setting.

## Complexity budget

Reuse existing lifecycle and recovery behavior wherever possible. This integration does not require cross-repository duplicate-work coordination for moved issues, new responses to mid-run label removal or manual cancellation/completion, comprehensive discovery and adoption of competing GitHub PRs, automatic pauses on project moves, credential-removal approval, or special conflict handling for Linear's native GitHub integration.

Prefer the ordinary end-to-end path and existing recovery mechanisms over new coordination machinery. Remaining implementation facts should be investigated during implementation rather than turned into speculative product requirements.

## Implementation follow-through

This decision establishes the agreed product scope. Implement the separation of issue tracking and repository hosting through the ontology-first workflow where domain vocabulary or generated contracts need to change, preserving existing provider defaults and historical Work Item provenance.
