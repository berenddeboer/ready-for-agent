import type { Layer } from "effect"
import {
  type LinearService,
  type LinearServiceTestFixture,
  defaultLinearServiceShape,
  makeLinearServiceTest,
} from "@ready-for-agent/linear-service"

export const stubLinearServiceLayer = (
  fixture: LinearServiceTestFixture = {},
): Layer.Layer<LinearService> => makeLinearServiceTest(fixture)

export { defaultLinearServiceShape }
