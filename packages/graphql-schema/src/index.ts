import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

export const typeDefs = readFileSync(
  join(packageRoot, "schema.graphql"),
  "utf8",
)
