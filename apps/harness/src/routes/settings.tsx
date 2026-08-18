/**
 * `/settings` — browser-addressable Harness Settings overlay
 * (issues #840 / #1146).
 *
 * The dialog itself lives in root chrome; this route supplies the canonical
 * Pipeline background for direct navigation and refresh. In-app opens mask
 * the retained runtime surface instead of landing here.
 */
import { createFileRoute } from "@tanstack/react-router"
import { PipelinePage } from "../pipeline-page.js"

export const Route = createFileRoute("/settings")({
  component: PipelinePage,
})
