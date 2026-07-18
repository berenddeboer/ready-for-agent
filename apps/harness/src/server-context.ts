export type { ApplicationRequestContext } from "./application-request-context.ts"

import type { ApplicationRequestContext } from "./application-request-context.ts"

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: ApplicationRequestContext
    }
  }
}
