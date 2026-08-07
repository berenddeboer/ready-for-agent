import { createFileRoute } from "@tanstack/react-router"
import { PipelinePage } from "../pipeline-page.js"

/** The `/` file route delegates its shared background to a non-route module. */
export const Route = createFileRoute("/")({
  component: PipelinePage,
})
