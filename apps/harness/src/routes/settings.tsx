/**
 * `/settings` — browser-addressable Harness Settings overlay (issue #840).
 *
 * The dialog itself lives in root chrome; this route supplies the canonical
 * Pipeline background for direct navigation and refresh. Explicit opens from
 * other pages also land here so the URL and history entry stay consistent.
 */
import { createFileRoute } from "@tanstack/react-router"
import { PipelinePage } from "../pipeline-page.js"

export const Route = createFileRoute("/settings")({
  component: PipelinePage,
})
