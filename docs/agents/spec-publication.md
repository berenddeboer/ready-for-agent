# Publish a Spec

Follow the repository's [Issue Tracker routing](issue-tracker.md). GitHub Issues
is only a destination when configured as the Issue Tracker, not when it just
hosts the code.

1. Save the approved title and Markdown body. For each design document the Spec
   incorporates, put a permalink to the **approved revision** in the body and
   verify it opens that revision. Use GitHub file permalinks with a full commit
   SHA that will remain reachable from a retained branch or tag, not just a
   temporary pull request branch. For a design not already in Git, use an
   approved copy in a published commit or include its approved scope in the
   parent text. Never pin the current branch tip as a substitute for an unknown
   approved revision.
2. Before creating the issue, generate the baseline comment from the same title
   and body, passing every incorporated design permalink (omit the arguments
   if no design documents are incorporated):

   ```bash
   bun scripts/render-spec-baseline.ts "$title" "$body_file" \
     "${approved_design_urls[@]}" > "$baseline_file"
   ```

3. Resolve both labels (`spec` and `ready-for-agent`) on the configured tracker.
   Reuse a label if it exists; create `spec` if needed and permitted. Publish the
   parent **without either label**, post the generated comment verbatim on that
   issue, and verify the saved comment contains the snapshot. Append
   `[Approved Spec baseline](<COMMENT_URL>)` to the parent description, using
   the exact URL returned by the tracker. Add both labels only after the
   snapshot and its citation are in place. Verify the description, comment,
   and labels. On a partial write, reuse the issue and snapshot; do not create
   a duplicate or edit the snapshot. Report both URLs.

   - **GitHub Issues:** set `issue_repo` to the configured issue repository
     (`OWNER/REPO`). Capture the URL returned by creation and use it for all
     further operations:

     ```bash
     issue_url=$(gh issue create --repo "$issue_repo" --title "$title" --body-file "$body_file") &&
       snapshot_url=$(gh issue comment "$issue_url" --body-file "$baseline_file")
     ```

     After verifying the comment, save the description with the citation in
     a separate file and update the issue:

     ```bash
     {
       cat "$body_file"
       printf '\n\n[Approved Spec baseline](<%s>)\n' "$snapshot_url"
     } > "$marked_body_file"
     gh issue edit "$issue_url" --body-file "$marked_body_file" &&
       gh issue edit "$issue_url" --add-label spec,ready-for-agent
     ```

   - **Linear:** create in the resolved project and team. Post the snapshot
     using `commentCreate` and obtain `comment.url`. Use `issueUpdate` to put
     the citation in `description`, then add the resolved label IDs using
     `addedLabelIds` (or the integration's equivalent that preserves existing
     labels).

## Existing Specs

To mark an existing parent, read it and its comments before changing anything.
Reuse its cited publication snapshot if present. Otherwise recover identifiable
approved text and fixed design revisions, or use the parent as written when
there is no identifiable prior approval. If evidence materially conflicts, ask
the operator which scope to capture; do not write a replacement baseline while
the question is unresolved.

Generate and verify the snapshot comment as above, **on the existing issue**.
Append or verify the snapshot citation without changing the existing issue
text. Then add just `spec`: use `gh issue edit "$issue_url" --add-label spec`
or set Linear `addedLabelIds` to the `spec` label ID alone. Leave the existing
triage label, title, and state unchanged. Report both URLs.

A parent already labelled `spec` outside this workflow can still be
discovered. If it has no snapshot, recover identifiable approved text and
fixed design revisions from the parent and its comments:
`Approved design baseline` links, pinned links (including bare URLs) in
`## Approved design revisions` sections, and archived text after a comment's
`## Approved Spec baseline` heading, which can follow introductory prose.
The archive ends at the next heading of the same or higher level; use nested
headings for subsections of the approved text. A pinned link labelled `Design`
in the archive or parent is also recognized.
Use a comment as approved scope only when the parent identifies that exact
comment with an `Approved Spec baseline` link, either on its own line or in
prose. Keep that citation if the live description is edited. A marker or
heading by itself is a claim, not approval: if an uncited comment would change
the selected scope, retain it for review. Otherwise use the marked parent as
written if there is no identifiable approved text.
If a cited snapshot or archive supplies the approved text, retain additional
design links found only in the live parent for review rather than adding them
to the baseline.
Keep conflicting approvals or unreadable snapshots for review with their
sources and the fallback parent. A comment does not amend a publication
snapshot. A mutable link or a child PR's local-only scope is not approval.
