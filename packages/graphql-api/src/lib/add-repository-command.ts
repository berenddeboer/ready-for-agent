import { spawnSync } from "node:child_process"

export const OPERATOR_BINARY = "ready-for-agent"
export const ADD_REPOSITORY_PATH_PLACEHOLDER = "/path/to/local/repo"

export const commandExistsOnPath = (command: string): boolean =>
  spawnSync("which", [command], { encoding: "utf8" }).status === 0

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
