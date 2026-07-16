type ApplicationDisposer = () => Promise<void>

const disposerKey = Symbol.for(
  "@ready-for-agent/harness/development-application-disposer",
)

type DevelopmentGlobal = typeof globalThis & {
  [disposerKey]?: ApplicationDisposer
}

const developmentGlobal = globalThis as DevelopmentGlobal

export const registerDevelopmentApplicationDisposer = (
  disposer: ApplicationDisposer,
) => {
  developmentGlobal[disposerKey] = disposer
}

export const unregisterDevelopmentApplicationDisposer = (
  disposer: ApplicationDisposer,
) => {
  if (developmentGlobal[disposerKey] === disposer) {
    delete developmentGlobal[disposerKey]
  }
}

export const disposeDevelopmentApplication = async () => {
  const disposer = developmentGlobal[disposerKey]
  if (disposer === undefined) return

  delete developmentGlobal[disposerKey]
  await disposer()
}
