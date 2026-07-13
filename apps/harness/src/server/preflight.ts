import { createApplication } from "./application.server.js"

if (import.meta.main) {
  const application = await createApplication()
  await application.dispose()
}
