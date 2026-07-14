import { createApplication } from "./application.server.js"

if (import.meta.main) {
  const application = await createApplication(process.env, {
    startWorker: false,
  })
  await application.dispose()
}
