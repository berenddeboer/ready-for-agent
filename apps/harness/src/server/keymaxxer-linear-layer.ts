import { Context, Duration, Effect, Layer, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import type { ReadyLabeledIssue } from "@ready-for-agent/forge-contract"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  LINEAR_API_KEY_ENV_VAR,
  LINEAR_VAULT_ACCOUNT,
  LINEAR_VAULT_PROVIDER,
  type LinearHelperOperation,
  type LinearIssueSnapshot,
  type LinearProject,
  LinearRequestError,
  LinearService,
  type LinearServiceError,
  type LinearServiceShape,
  type LinearTeamWorkflow,
  formatLinearHelperShellCommand,
  resolveLinearHelperChildSpawn,
} from "@ready-for-agent/linear-service"
import { ambientLinearLayer } from "./ambient-linear-layer.js"
import { parseSerializedIssues } from "./forge-helper-schemas.js"

const LINEAR_VAULT_METADATA_BUDGET = Duration.seconds(20)
const dummyRepository = {
  forge: "github",
  forgeHost: "github.com",
  projectPath: "linear/api",
}

type VaultSecretProbe =
  | { readonly kind: "secret"; readonly name: string }
  | { readonly kind: "miss" }
  | { readonly kind: "unavailable" }

const requestError = (message: string, stdout?: string) =>
  new LinearRequestError({
    message:
      stdout === undefined || stdout.trim() === ""
        ? message
        : `${message}: ${stdout.trim()}`,
  })

const encodeArgument = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url")

const LinearProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
})
const LinearWorkflowStateSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  position: Schema.Number,
})
const LinearTeamWorkflowSchema = Schema.Struct({
  teamId: Schema.String,
  teamKey: Schema.String,
  teamName: Schema.String,
  states: Schema.Array(LinearWorkflowStateSchema),
  suggestedInProgressStateId: Schema.NullOr(Schema.String),
  suggestedDoneStateId: Schema.NullOr(Schema.String),
})
const LinearIssueSnapshotSchema = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  teamId: Schema.String,
  teamKey: Schema.String,
  stateId: Schema.String,
  stateName: Schema.String,
  stateType: Schema.String,
})

/**
 * Vault-first Linear service layer. A personal API key (provider linear,
 * account api) is strictly more specific than ambient LINEAR_API_KEY.
 */
export const keymaxxerLinearLayer = (options: {
  readonly workspaceRoot: string
  readonly environment?: Partial<Record<string, string | undefined>>
  readonly makeService?: (token: string) => LinearServiceShape
  readonly makeAnonymousService?: () => LinearServiceShape
  readonly vaultMetadataBudget?: Duration.Duration
}): Layer.Layer<
  LinearService,
  never,
  KeymaxxerService | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    LinearService,
    Effect.gen(function* () {
      const keymaxxer = yield* KeymaxxerService
      const vaultBudget =
        options.vaultMetadataBudget ?? LINEAR_VAULT_METADATA_BUDGET
      const layerScope = yield* Effect.scope
      const ambientContext = yield* Layer.buildWithScope(
        ambientLinearLayer({
          environment: options.environment,
          makeService: options.makeService,
          makeAnonymousService: options.makeAnonymousService,
        }),
        layerScope,
      )
      const ambient = Context.get(ambientContext, LinearService)

      const probeVaultSecret = (): Effect.Effect<VaultSecretProbe> =>
        keymaxxer
          .findSecret({
            provider: LINEAR_VAULT_PROVIDER,
            account: LINEAR_VAULT_ACCOUNT,
          })
          .pipe(
            Effect.timeout(vaultBudget),
            Effect.map(
              (name): VaultSecretProbe =>
                name === null ? { kind: "miss" } : { kind: "secret", name },
            ),
            Effect.catchTags({
              TimeoutError: (): Effect.Effect<VaultSecretProbe> =>
                Effect.succeed({ kind: "unavailable" }),
              KeymaxxerError: (): Effect.Effect<VaultSecretProbe> =>
                Effect.succeed({ kind: "unavailable" }),
            }),
          )

      const runHelper = (
        tokenName: string,
        operation: LinearHelperOperation,
        args: readonly string[],
      ) =>
        keymaxxer.runWithSecrets({
          command: `${LINEAR_API_KEY_ENV_VAR}="$${tokenName}" ${formatLinearHelperShellCommand(
            resolveLinearHelperChildSpawn({ operation, args }),
          )}`,
          cwd: options.workspaceRoot,
          secrets: [tokenName],
          timeoutMs: 60_000,
        })

      const callHelper = <A>(input: {
        readonly operation: LinearHelperOperation
        readonly args: readonly string[]
        readonly tokenName: string
        readonly decode: (
          stdout: string,
        ) => Effect.Effect<A, LinearServiceError>
        readonly describe: string
      }) =>
        runHelper(input.tokenName, input.operation, input.args).pipe(
          Effect.mapError((error) =>
            requestError(`Failed to ${input.describe}`, String(error)),
          ),
          Effect.flatMap((result) => {
            if (result.exitCode !== 0) {
              return Effect.fail(
                requestError(
                  `Linear helper failed while ${input.describe}`,
                  result.stderr,
                ),
              )
            }
            return input.decode(result.stdout)
          }),
        )

      const withToken = <A>(
        runAmbient: () => Effect.Effect<A, LinearServiceError>,
        runSecret: (tokenName: string) => Effect.Effect<A, LinearServiceError>,
      ) =>
        Effect.gen(function* () {
          const probe = yield* probeVaultSecret()
          if (probe.kind === "secret") {
            return yield* runSecret(probe.name)
          }
          return yield* runAmbient()
        })

      const parseIssues = parseSerializedIssues((repository, operation) =>
        requestError(`Failed to ${operation} for ${repository.projectPath}`),
      )

      return LinearService.of({
        getAuthenticatedUserLogin: () =>
          withToken(
            () => ambient.getAuthenticatedUserLogin(),
            (tokenName) =>
              callHelper({
                operation: "get-authenticated-user-login",
                args: [],
                tokenName,
                decode: (stdout) => {
                  const login = stdout.trim()
                  return login === ""
                    ? Effect.fail(requestError("Linear viewer id was empty"))
                    : Effect.succeed(login)
                },
                describe: "reading the Linear viewer",
              }),
          ),
        listReadyIssues: (projectId) =>
          withToken(
            () => ambient.listReadyIssues(projectId),
            (tokenName) =>
              callHelper({
                operation: "list-ready-issues",
                args: [encodeArgument(projectId)],
                tokenName,
                decode: (stdout) =>
                  parseIssues(stdout, dummyRepository) as Effect.Effect<
                    readonly ReadyLabeledIssue[],
                    LinearServiceError
                  >,
                describe: `listing Ready-labeled Linear Issues in project ${projectId}`,
              }),
          ),
        listProjects: () =>
          withToken(
            () => ambient.listProjects(),
            (tokenName) =>
              callHelper({
                operation: "list-projects",
                args: [],
                tokenName,
                decode: (stdout) =>
                  Schema.decodeUnknownEffect(
                    Schema.fromJsonString(Schema.Array(LinearProjectSchema)),
                  )(stdout).pipe(
                    Effect.mapError(() =>
                      requestError("Linear returned invalid projects", stdout),
                    ),
                  ) as Effect.Effect<
                    readonly LinearProject[],
                    LinearServiceError
                  >,
                describe: "listing Linear projects",
              }),
          ),
        listProjectWorkflow: (projectId) =>
          withToken(
            () => ambient.listProjectWorkflow(projectId),
            (tokenName) =>
              callHelper({
                operation: "list-project-workflow",
                args: [encodeArgument(projectId)],
                tokenName,
                decode: (stdout) =>
                  Schema.decodeUnknownEffect(
                    Schema.fromJsonString(
                      Schema.Array(LinearTeamWorkflowSchema),
                    ),
                  )(stdout).pipe(
                    Effect.mapError(() =>
                      requestError("Linear returned invalid workflow", stdout),
                    ),
                  ) as Effect.Effect<
                    readonly LinearTeamWorkflow[],
                    LinearServiceError
                  >,
                describe: `listing Linear workflow states for project ${projectId}`,
              }),
          ),
        getIssue: (nativeId) =>
          withToken(
            () => ambient.getIssue(nativeId),
            (tokenName) =>
              callHelper({
                operation: "get-issue",
                args: [encodeArgument(nativeId)],
                tokenName,
                decode: (stdout) =>
                  Schema.decodeUnknownEffect(
                    Schema.fromJsonString(LinearIssueSnapshotSchema),
                  )(stdout).pipe(
                    Effect.mapError(() =>
                      requestError("Linear returned an invalid Issue", stdout),
                    ),
                  ) as Effect.Effect<LinearIssueSnapshot, LinearServiceError>,
                describe: `reading Linear Issue ${nativeId}`,
              }),
          ),
        updateIssueState: (nativeId, stateId) =>
          withToken(
            () => ambient.updateIssueState(nativeId, stateId),
            (tokenName) =>
              callHelper({
                operation: "update-issue-state",
                args: [encodeArgument(nativeId), encodeArgument(stateId)],
                tokenName,
                decode: () => Effect.void,
                describe: `updating Linear Issue ${nativeId} workflow state`,
              }),
          ),
        ensureMilestoneComment: (nativeId, marker, body) =>
          withToken(
            () => ambient.ensureMilestoneComment(nativeId, marker, body),
            (tokenName) =>
              callHelper({
                operation: "ensure-milestone-comment",
                args: [
                  encodeArgument(nativeId),
                  encodeArgument(marker),
                  encodeArgument(body),
                ],
                tokenName,
                decode: () => Effect.void,
                describe: `posting a Linear milestone comment on Issue ${nativeId}`,
              }),
          ),
        hasCredentials: () =>
          probeVaultSecret().pipe(
            Effect.flatMap((probe) =>
              probe.kind === "secret"
                ? Effect.succeed(true)
                : ambient.hasAmbientCredentials(),
            ),
          ),
        hasAmbientCredentials: () => ambient.hasAmbientCredentials(),
      })
    }),
  )
