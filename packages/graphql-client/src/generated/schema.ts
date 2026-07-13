// @ts-nocheck
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Scalars = {
    Boolean: boolean,
    ID: string,
    String: string,
}

export interface Query {
    health: Scalars['Boolean']
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

export interface Mutation {
    addRepository: Repository
    __typename: 'Mutation'
}

export interface QueryGenqlSelection{
    health?: boolean | number
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

export interface AddRepositoryInput {githubOwner: Scalars['String'],githubRepo: Scalars['String'],localPath: Scalars['String'],isBare: Scalars['Boolean']}

export interface MutationGenqlSelection{
    addRepository?: (RepositoryGenqlSelection & { __args: {input: AddRepositoryInput} })
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
    


    const Mutation_possibleTypes: string[] = ['Mutation']
    export const isMutation = (obj?: { __typename?: any } | null): obj is Mutation => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isMutation"')
      return Mutation_possibleTypes.includes(obj.__typename)
    }
    