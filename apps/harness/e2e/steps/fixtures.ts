import { test as base, createBdd } from "playwright-bdd"

export type LiveE2eWorld = {
  fixtureCheckoutPath?: string
  cleanupFixtureCheckout?: () => void
}

export const test = base.extend<{ world: LiveE2eWorld }>({
  world: async ({ page: _page }, use) => {
    const world: LiveE2eWorld = {}
    await use(world)
    world.cleanupFixtureCheckout?.()
  },
})

export const { Given, When, Then } = createBdd(test)
