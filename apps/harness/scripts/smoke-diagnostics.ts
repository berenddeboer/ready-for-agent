import { spawnSync } from "node:child_process"

/** Inspect only the smoke process group, never command arguments or environment. */
export const smokeProcessSnapshot = (processGroupId: number): string => {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,stat=,comm="], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error !== undefined || result.status !== 0) {
    return "Smoke process snapshot unavailable (ps failed or timed out)."
  }
  const processes = result.stdout
    .split("\n")
    .filter((line) => line.trim().split(/\s+/, 3)[2] === String(processGroupId))
  return [
    "PID PPID PGID STAT COMM",
    ...processes,
    ...(processes.length === 0 ? ["(smoke process group has exited)"] : []),
  ].join("\n")
}
