# Extract a shared Repair Fallback helper

Commit and Create PR each independently implement the same recovery behavior — attempt the native mutation, and if it doesn't establish its postcondition, continue the Work Item Session so the Agent Turn completes the step itself, then re-verify the postcondition rather than trusting the turn's report — with no shared code between the two beyond prompt-string builders. Mark PR Ready for Review needs this same behavior (issue #24), which would make it a third independent copy.

We're extracting a shared Repair Fallback helper — parameterized by the native-attempt function, the postcondition check, the prompt, and any step-specific pre-checks (e.g. Create PR's credential resolution) — and migrating Commit and Create PR onto it rather than writing a third bespoke copy. This is split into two tickets: a pure prefactor (extract + migrate the two existing steps, no behavior change) followed by the Mark PR Ready for Review feature ticket built on top of it.

**Considered options:** (1) leave three independent implementations — rejected, since the rule-of-three duplication was already flagged as messy in one of the two existing copies; (2) write the shared helper but leave Commit/Create PR on their old code — rejected, since that leaves two implementations of the same behavior to keep in sync by hand indefinitely.
