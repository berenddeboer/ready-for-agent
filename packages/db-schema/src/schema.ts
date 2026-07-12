import { sql } from "drizzle-orm"
import { integer, snakeCase, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ulid } from "ulidx"

export const repository = snakeCase.table(
  "repository",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => ulid()),
    githubOwner: text().notNull(),
    githubRepo: text().notNull(),
    localPath: text().notNull().unique(),
    isBare: integer({ mode: "boolean" }).notNull(),
    paused: integer({ mode: "boolean" }).notNull().default(true),
    createdAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
    updatedAt: integer({ mode: "number" })
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    uniqueIndex("repository_github_owner_repo_lower_uidx").on(
      sql`lower(${t.githubOwner})`,
      sql`lower(${t.githubRepo})`,
    ),
  ],
)
