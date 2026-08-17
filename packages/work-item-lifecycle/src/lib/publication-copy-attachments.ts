import { Effect, FileSystem } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  type PublicationCopy,
  listMarkdownImageDestinations,
  replaceMarkdownImageDestinations,
  resolveAttachmentImageCandidate,
} from "./publication-copy.js"
import { workItemAttachmentDirectory } from "./work-item-attachment-directory.js"

const isInsideDirectory = (filePath: string, directory: string): boolean => {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`
  return filePath.startsWith(prefix)
}

const inspectRegularFileInside = (
  filePath: string,
  attachmentDirectory: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(filePath)
    if (!exists) {
      return null
    }
    const stat = yield* fs.stat(filePath)
    if (stat.type !== "File") {
      return null
    }
    const realFile = yield* fs.realPath(filePath)
    const realRoot = yield* fs.realPath(attachmentDirectory)
    if (!isInsideDirectory(realFile, realRoot)) {
      return null
    }
    return realFile
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * After normalize and before persist: upload in-directory publication images
 * on GitHub and rewrite those markdown destinations. Best-effort: missing
 * files, sandbox escapes, upload failure, and GitLab leave links unchanged.
 */
export const rewritePublicationCopyAttachments = (input: {
  readonly copy: PublicationCopy
  readonly workItemId: string
  readonly repositoryId: string
}): Effect.Effect<
  PublicationCopy,
  never,
  FileSystem.FileSystem | DbService | GitHubService
> =>
  Effect.gen(function* () {
    const attachmentDirectory = workItemAttachmentDirectory({
      workItemId: input.workItemId,
    })
    const destinations = listMarkdownImageDestinations(input.copy.body)
    const candidates: Array<{
      readonly destination: string
      readonly filePath: string
      readonly name: string
      readonly contentType: string
    }> = []
    for (const destination of destinations) {
      const candidate = resolveAttachmentImageCandidate({
        destination,
        attachmentDirectory,
      })
      if (candidate === null) {
        continue
      }
      const realFile = yield* inspectRegularFileInside(
        candidate.filePath,
        attachmentDirectory,
      )
      if (realFile === null) {
        continue
      }
      candidates.push({
        destination,
        filePath: realFile,
        name: candidate.name,
        contentType: candidate.contentType,
      })
    }
    if (candidates.length === 0) {
      return input.copy
    }

    const db = yield* DbService
    const repositories = yield* db.listRepositories.pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Failed to resolve repository for publication-copy image upload",
          { workItemId: input.workItemId, error },
        ).pipe(Effect.as<readonly never[]>([])),
      ),
    )
    const repository = repositories.find(({ id }) => id === input.repositoryId)
    if (repository === undefined || repository.forge !== "github") {
      return input.copy
    }

    const github = yield* GitHubService
    const uploadedByFile = new Map<string, string>()
    const replacements = new Map<string, string>()
    for (const candidate of candidates) {
      const already = uploadedByFile.get(candidate.filePath)
      if (already !== undefined) {
        replacements.set(candidate.destination, already)
        continue
      }
      const url = yield* github
        .uploadUserAttachment(
          {
            forge: repository.forge,
            forgeHost: repository.forgeHost,
            projectPath: repository.projectPath,
          },
          {
            name: candidate.name,
            contentType: candidate.contentType,
            filePath: candidate.filePath,
          },
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Publication-copy image upload failed; leaving local link",
              {
                workItemId: input.workItemId,
                filePath: candidate.filePath,
                error,
              },
            ).pipe(Effect.as(null)),
          ),
        )
      if (url === null || url === "") {
        continue
      }
      uploadedByFile.set(candidate.filePath, url)
      replacements.set(candidate.destination, url)
    }
    if (replacements.size === 0) {
      return input.copy
    }
    return {
      title: input.copy.title,
      body: replaceMarkdownImageDestinations(input.copy.body, replacements),
    }
  })
