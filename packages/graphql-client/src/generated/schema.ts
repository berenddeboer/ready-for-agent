// @ts-nocheck
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Scalars = {
    Boolean: boolean,
    ID: string,
    String: string,
    Int: number,
}

export interface Query {
    health: Scalars['Boolean']
    repositories: Repository[]
    __typename: 'Query'
}

export interface Repository {
    id: Scalars['ID']
    githubOwner: Scalars['String']
    githubRepo: Scalars['String']
    localPath: Scalars['String']
    isBare: Scalars['Boolean']
    paused: Scalars['Boolean']
    __typename: 'Repository'
}

export interface RepositoryRefresh {
    fetched: Scalars['Int']
    inserted: Scalars['Int']
    updated: Scalars['Int']
    deleted: Scalars['Int']
    unchanged: Scalars['Int']
    __typename: 'RepositoryRefresh'
}

export interface Mutation {
    addRepository: Repository
    refreshRepository: RepositoryRefresh
    __typename: 'Mutation'
}

export interface QueryGenqlSelection{
    health?: boolean | number
    repositories?: RepositoryGenqlSelection
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface RepositoryGenqlSelection{
    id?: boolean | number
    githubOwner?: boolean | number
    githubRepo?: boolean | number
    localPath?: boolean | number
    isBare?: boolean | number
    paused?: boolean | number
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface RepositoryRefreshGenqlSelection{
    fetched?: boolean | number
    inserted?: boolean | number
    updated?: boolean | number
    deleted?: boolean | number
    unchanged?: boolean | number
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface AddRepositoryInput {githubOwner: Scalars['String'],githubRepo: Scalars['String'],localPath: Scalars['String'],isBare: Scalars['Boolean']}

export interface MutationGenqlSelection{
    addRepository?: (RepositoryGenqlSelection & { __args: {input: AddRepositoryInput} })
    refreshRepository?: (RepositoryRefreshGenqlSelection & { __args: {repositoryId: Scalars['ID']} })
    __typename?: boolean | number
    __scalar?: boolean | number
}


    const Query_possibleTypes: string[] = ['Query']
    export const isQuery = (obj?: { __typename?: any } | null): obj is Query => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isQuery"')
      return Query_possibleTypes.includes(obj.__typename)
    }
    


    const Repository_possibleTypes: string[] = ['Repository']
    export const isRepository = (obj?: { __typename?: any } | null): obj is Repository => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isRepository"')
      return Repository_possibleTypes.includes(obj.__typename)
    }
    


    const RepositoryRefresh_possibleTypes: string[] = ['RepositoryRefresh']
    export const isRepositoryRefresh = (obj?: { __typename?: any } | null): obj is RepositoryRefresh => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isRepositoryRefresh"')
      return RepositoryRefresh_possibleTypes.includes(obj.__typename)
    }
    


    const Mutation_possibleTypes: string[] = ['Mutation']
    export const isMutation = (obj?: { __typename?: any } | null): obj is Mutation => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isMutation"')
      return Mutation_possibleTypes.includes(obj.__typename)
    }
    