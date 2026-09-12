// This file is generated from ontology/rfa.ttl.
// Run `bunx nx run lifecycle-model:generate` to update it.

import { Schema } from "effect"

export const FORGES = [
  "github",
  "gitlab",
  "azure-devops",
] as const

export const Forge = Schema.Literals(FORGES)
export type Forge = typeof Forge.Type

export const isForge = (value: unknown): value is Forge =>
  FORGES.some((forge) => forge === value)
