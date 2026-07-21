import { accessSync, constants } from "node:fs"
import { basename, delimiter, dirname, join, normalize } from "node:path"

export const OPERATOR_BINARY = "ready-for-agent"
export const ADD_REPOSITORY_PATH_PLACEHOLDER = "/path/to/local/repo"

const isPackageRunnerBinDirectory = (directory: string): boolean => {
  const normalized = normalize(directory)
  return (
    basename(normalized) === ".bin" &&
    basename(dirname(normalized)) === "node_modules"
  )
}

export const commandExistsOnPath = (
  command: string,
  pathEnv: string | undefined = process.env.PATH,
): boolean => {
  if (pathEnv === undefined || pathEnv.length === 0) {
    return false
  }
  for (const directory of pathEnv.split(delimiter)) {
    if (directory.length === 0 || isPackageRunnerBinDirectory(directory)) {
      continue
    }
    try {
      accessSync(join(directory, command), constants.X_OK)
      return true
    } catch {
      // keep looking
    }
  }
  return false
}

export const isOperatorBinaryOnPath = (
  commandExists: (command: string) => boolean,
): boolean => commandExists(OPERATOR_BINARY)

export const addRepositoryCommand = (options: {
  readonly operatorBinaryOnPath: boolean
}): string => {
  const invocation = options.operatorBinaryOnPath
    ? OPERATOR_BINARY
    : `npx ${OPERATOR_BINARY}`
  return `${invocation} add ${ADD_REPOSITORY_PATH_PLACEHOLDER}`
}

export const resolveAddRepositoryCommand = (
  commandExists: (command: string) => boolean = commandExistsOnPath,
): string =>
  addRepositoryCommand({
    operatorBinaryOnPath: isOperatorBinaryOnPath(commandExists),
  })
