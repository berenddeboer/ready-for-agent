import { createApplication } from "./application.server.js"

if (import.meta.main) {
  const startedAt = Date.now()
  const report = (phase: string) => {
    if (process.env.HARNESS_STARTUP_DIAGNOSTICS === "1") {
      console.info(
        `[preflight pid=${process.pid} elapsedMs=${Date.now() - startedAt}] ${phase}`,
      )
    }
  }
  report("create:start")
  const application = await createApplication(process.env, {
    startWorker: false,
  })
  report("create:complete")
  report("dispose:start")
  await application.dispose()
  report("dispose:complete; awaiting process exit")
}
