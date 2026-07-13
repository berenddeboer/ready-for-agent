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
    config: Config
    issues: Issue[]
    __typename: 'Query'
}

export interface Config {
    defaultModel: Scalars['String']
    defaultVariant: Scalars['String']
    __typename: 'Config'
}

export interface Repository {
    id: Scalars['ID']
    githubOwner: Scalars['String']
    githubRepo: Scalars['String']
    localPath: Scalars['String']
    isBare: Scalars['Boolean']
    paused: Scalars['Boolean']
    issuesReconciledAt: (Scalars['String'] | null)
    __typename: 'Repository'
}

export type IssueState = 'OPEN' | 'CLOSED'

export interface Issue {
    id: Scalars['ID']
    repositoryId: Scalars['ID']
    githubIssueNumber: Scalars['Int']
    title: Scalars['String']
    body: Scalars['String']
    url: Scalars['String']
    state: IssueState
    githubCreatedAt: Scalars['String']
    __typename: 'Issue'
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
    updateConfig: Config
    __typename: 'Mutation'
}

export interface QueryGenqlSelection{
    health?: boolean | number
    repositories?: RepositoryGenqlSelection
    config?: ConfigGenqlSelection
    issues?: (IssueGenqlSelection & { __args: {repositoryId: Scalars['ID']} })
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface ConfigGenqlSelection{
    defaultModel?: boolean | number
    defaultVariant?: boolean | number
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
    issuesReconciledAt?: boolean | number
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface IssueGenqlSelection{
    id?: boolean | number
    repositoryId?: boolean | number
    githubIssueNumber?: boolean | number
    title?: boolean | number
    body?: boolean | number
    url?: boolean | number
    state?: boolean | number
    githubCreatedAt?: boolean | number
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

export interface UpdateConfigInput {defaultModel: Scalars['String'],defaultVariant: Scalars['String']}

export interface MutationGenqlSelection{
    addRepository?: (RepositoryGenqlSelection & { __args: {input: AddRepositoryInput} })
    refreshRepository?: (RepositoryRefreshGenqlSelection & { __args: {repositoryId: Scalars['ID']} })
    updateConfig?: (ConfigGenqlSelection & { __args: {input: UpdateConfigInput} })
    __typename?: boolean | number
    __scalar?: boolean | number
}


    const Query_possibleTypes: string[] = ['Query']
    export const isQuery = (obj?: { __typename?: any } | null): obj is Query => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isQuery"')
      return Query_possibleTypes.includes(obj.__typename)
    }
    


    const Config_possibleTypes: string[] = ['Config']
    export const isConfig = (obj?: { __typename?: any } | null): obj is Config => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isConfig"')
      return Config_possibleTypes.includes(obj.__typename)
    }
    


    const Repository_possibleTypes: string[] = ['Repository']
    export const isRepository = (obj?: { __typename?: any } | null): obj is Repository => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isRepository"')
      return Repository_possibleTypes.includes(obj.__typename)
    }
    


    const Issue_possibleTypes: string[] = ['Issue']
    export const isIssue = (obj?: { __typename?: any } | null): obj is Issue => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isIssue"')
      return Issue_possibleTypes.includes(obj.__typename)
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
    

export const enumIssueState = {
   OPEN: 'OPEN' as const,
   CLOSED: 'CLOSED' as const
}
