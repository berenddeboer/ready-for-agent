/**
 * Shared Keymaxxer CI Gate catalog, CI Gate observation, and PR Status Check
 * operation wiring for Azure DevOps and GitLab.
 *
 * Each adapter keeps its own tracing names, helper process, vault probe, and
 * error types. This module owns the identical operation names, argument
 * encoding, result schemas, and vault-or-ambient delegation.
 */
import { Effect, Schema } from "effect"
import type {
  CiGateCatalogEntry,
  CiGateObservation,
  ForgeRepository,
  ObserveCiGateInput,
  PullRequestCheckStatus,
} from "@ready-for-agent/forge-contract"
import {
  SerializedCiGateCatalog,
  SerializedCiGateObservation,
  SerializedPullRequestCheckStatus,
  encodeArgument,
} from "./forge-helper-schemas.js"

type CiPrCheckHelperOperation =
  | "list-ci-gate-catalog"
  | "observe-ci-gate"
  | "get-pr-check-status"

type KeymaxxerCiPrCheckCallHelper<Repo, E> = <A>(input: {
  readonly operation: CiPrCheckHelperOperation
  readonly repository: Repo
  readonly tokenName: string
  readonly describe: string
  readonly args?: readonly string[]
  readonly decode: (stdout: string) => Effect.Effect<A, E>
}) => Effect.Effect<A, E>

type KeymaxxerVaultOrAmbient<Repo, Service, E> = <A>(
  repository: Repo,
  whenVault: (tokenName: string) => Effect.Effect<A, E>,
  whenAmbient: (service: Service) => Effect.Effect<A, E>,
) => Effect.Effect<A, E>

type KeymaxxerRequestErrorFactory<E> = (
  repository: ForgeRepository,
  operation: string,
  detail?: string,
) => E

type KeymaxxerCiPrCheckAmbientService<Repo, E> = {
  readonly listCiGateCatalog: (
    repository: Repo,
  ) => Effect.Effect<readonly CiGateCatalogEntry[], E>
  readonly observeCiGate: (
    repository: Repo,
    input: ObserveCiGateInput,
  ) => Effect.Effect<CiGateObservation, E>
  readonly getPullRequestCheckStatus: (
    repository: Repo,
    headRefName: string,
  ) => Effect.Effect<PullRequestCheckStatus, E>
}

const decodeJson =
  <A, I, E>(
    schema: Schema.Codec<A, I>,
    repository: ForgeRepository,
    describe: string,
    requestError: KeymaxxerRequestErrorFactory<E>,
  ) =>
  (stdout: string): Effect.Effect<A, E> =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout).pipe(
      Effect.mapError(() => requestError(repository, describe, stdout)),
    )

export const keymaxxerCiGateAndPrCheckOperations = <
  Repo extends ForgeRepository,
  E,
  Service extends KeymaxxerCiPrCheckAmbientService<Repo, E>,
>(adapters: {
  readonly callHelper: KeymaxxerCiPrCheckCallHelper<Repo, E>
  readonly withVaultOrAmbient: KeymaxxerVaultOrAmbient<Repo, Service, E>
  readonly requestError: KeymaxxerRequestErrorFactory<E>
}): KeymaxxerCiPrCheckAmbientService<Repo, E> => {
  const { callHelper, withVaultOrAmbient, requestError } = adapters
  return {
    listCiGateCatalog: (repository) =>
      withVaultOrAmbient(
        repository,
        (tokenName) =>
          callHelper({
            operation: "list-ci-gate-catalog",
            repository,
            tokenName,
            describe: "list CI Gate Definitions",
            decode: decodeJson(
              SerializedCiGateCatalog,
              repository,
              "decode CI Gate catalog",
              requestError,
            ),
          }),
        (ambientService) => ambientService.listCiGateCatalog(repository),
      ),
    observeCiGate: (repository, input) =>
      withVaultOrAmbient(
        repository,
        (tokenName) =>
          callHelper({
            operation: "observe-ci-gate",
            repository,
            tokenName,
            describe: "observe CI Gate Definitions",
            args: [
              encodeArgument(
                JSON.stringify({
                  definitionIdentities: input.definitionIdentities,
                  lastRunIdentities: input.lastRunIdentities,
                }),
              ),
            ],
            decode: decodeJson(
              SerializedCiGateObservation,
              repository,
              "decode CI Gate observation",
              requestError,
            ),
          }),
        (ambientService) => ambientService.observeCiGate(repository, input),
      ),
    getPullRequestCheckStatus: (repository, headRefName) =>
      withVaultOrAmbient(
        repository,
        (tokenName) =>
          callHelper({
            operation: "get-pr-check-status",
            repository,
            tokenName,
            describe: "get pull request check status",
            args: [encodeArgument(headRefName)],
            decode: decodeJson(
              SerializedPullRequestCheckStatus,
              repository,
              "decode pull request check status",
              requestError,
            ),
          }),
        (ambientService) =>
          ambientService.getPullRequestCheckStatus(repository, headRefName),
      ),
  }
}
