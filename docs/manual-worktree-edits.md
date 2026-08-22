# Manually Editing a Work Item's Worktree

Follow this procedure before touching a Work Item's worktree by hand — for
example to resolve a merge conflict, apply a hotfix, or inspect a broken
build. It applies to any Work Item the harness is or might still be driving,
not just ones that currently look idle.

**The gap this closes**: Pause Work Item only blocks the *next* Lifecycle
Step from starting. It does not stop a Step Run that is already running. If
you start editing a worktree while its Step Run is still running, the
harness's Agent Backend can write to the same files at the same time,
clobbering your manual edit or corrupting its own. Stopping in-progress work
takes a second, separate action: Interrupt Work Item.

Terms below (Work Item, Step Run, Pause Work Item, Interrupt Work Item,
Retry, Start Work Item) are defined in the [`CONTEXT.md`](../CONTEXT.md)
glossary — use them exactly as defined there.

## Procedure

1. **Check `hasActiveStepRun` for the Work Item.**

   ```graphql
   query {
     workItems(repositoryId: "<repositoryId>", issueNumber: <issueNumber>) {
       id
       paused
       hasActiveStepRun
       worktreePath
     }
   }
   ```

   Note the `id` and `worktreePath` for the next steps.

2. **Call Pause Work Item**, regardless of the `hasActiveStepRun` value from
   step 1. This stops any *further* Lifecycle Step from starting once the
   current one (if any) finishes.

   ```graphql
   mutation {
     pauseWorkItem(workItemId: "<id>") {
       id
       paused
       hasActiveStepRun
     }
   }
   ```

3. **If the response's `hasActiveStepRun` is still `true`, call Interrupt
   Work Item.** A Step Run was running when you paused, and Pause alone does
   not stop it. Interrupt Work Item is legal only while the Work Item is
   paused and a Step Run is running — call Pause first, exactly as above.

   ```graphql
   mutation {
     interruptWorkItem(workItemId: "<id>") {
       id
       paused
       hasActiveStepRun
     }
   }
   ```

   Re-query `hasActiveStepRun` (step 1's query) until it reports `false`
   before continuing. Do not begin editing while it is still `true`.

4. **Only once `hasActiveStepRun` is `false`, edit the worktree** at
   `worktreePath`. The harness will not start a new Step Run on this Work
   Item while it remains paused, so no admitted Agent Backend turn can write
   to the worktree concurrently with your edit.

5. **Resume once you are done:**
   - If you called Interrupt Work Item in step 3, resume with **Retry**, not
     Start Work Item — Interrupt clears the paused flag itself once that
     Step Run finishes, and the interrupted Step Run is retryable.
   - If step 1 already reported `hasActiveStepRun: false` and you only ever
     called Pause Work Item, resume with **Start Work Item**.

## Common mistake

Calling Pause Work Item and immediately editing the worktree without
checking whether a Step Run was running. If `hasActiveStepRun` was `true`,
that Step Run keeps running and writing to the worktree after Pause returns;
manual edits made before it finishes race the Agent Backend's own writes.
Always confirm `hasActiveStepRun: false` (via step 3's Interrupt, or because
step 1 already reported `false`) before editing.
