# Select one Agent Backend per Harness instance

Harness Config selects one Agent Backend for the next startup, defaulting existing and fresh configurations to OpenCode. Repositories and Work Items cannot select backends; changing the selection is rejected while any Work Item is unfinished, clears all Harness and Repository model selections, and blocks new Agent Turns and Work Item creation until restart. Startup inspection failure leaves the UI and guaranteed Agent-free Lifecycle Steps available in Agent Backend Unavailable rather than exiting or silently falling back; steps that may invoke an agent conditionally do not start. An explicit Recheck Agent Backend action refreshes readiness and the model catalog.

Every Work Item captures the Active Agent Backend as provenance. Build and review Agent Models and optional Thinking Levels are not stored on Work Items; each Agent Turn resolves them from current Repository settings falling back to Harness Config (review falls back to the resolved build selection). Existing records are migrated as OpenCode, backend-specific `variant` and concurrency names are replaced end-to-end, and model selections are atomic: omitting a model inherits the whole parent selection, while choosing a model without a Thinking Level uses that model's backend default.

## Consequences

Backend selection is a product setting but activation is a restart boundary because the application runtime is layered around one adapter. Captured backend provenance is visible on Work Item detail and completed-history/session views, but does not imply per-Work-Item routing. A settings change takes effect on the next Agent Turn of an existing Work Item without recreating it.
