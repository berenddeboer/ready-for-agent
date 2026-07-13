export const buildRunArgs = (input: {
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly variant: string
  readonly sessionId?: string
}): ReadonlyArray<string> => {
  const args = [
    "run",
    "--auto",
    "--format",
    "json",
    "--dir",
    input.cwd,
    "-m",
    input.model,
    "--variant",
    input.variant,
  ]

  if (input.sessionId !== undefined) {
    args.push("--session", input.sessionId)
  }

  args.push(input.prompt)
  return args
}
