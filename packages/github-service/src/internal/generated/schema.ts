// @ts-nocheck
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type Scalars = {
    DateTime: any,
    URI: any,
    String: string,
    Int: number,
    Boolean: boolean,
}

export interface Query {
    repository: (Repository | null)
    __typename: 'Query'
}

export interface Repository {
    issues: IssueConnection
    __typename: 'Repository'
}

export interface IssueConnection {
    nodes: ((Issue | null)[] | null)
    pageInfo: PageInfo
    __typename: 'IssueConnection'
}

export interface PageInfo {
    endCursor: (Scalars['String'] | null)
    hasNextPage: Scalars['Boolean']
    __typename: 'PageInfo'
}

export interface Issue {
    number: Scalars['Int']
    title: Scalars['String']
    body: Scalars['String']
    url: Scalars['URI']
    createdAt: Scalars['DateTime']
    state: IssueState
    __typename: 'Issue'
}

export type IssueState = 'OPEN' | 'CLOSED'

export interface QueryGenqlSelection{
    repository?: (RepositoryGenqlSelection & { __args: {owner: Scalars['String'], name: Scalars['String']} })
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface RepositoryGenqlSelection{
    issues?: (IssueConnectionGenqlSelection & { __args?: {first?: (Scalars['Int'] | null), after?: (Scalars['String'] | null), labels?: (Scalars['String'][] | null)} })
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface IssueConnectionGenqlSelection{
    nodes?: IssueGenqlSelection
    pageInfo?: PageInfoGenqlSelection
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface PageInfoGenqlSelection{
    endCursor?: boolean | number
    hasNextPage?: boolean | number
    __typename?: boolean | number
    __scalar?: boolean | number
}

export interface IssueGenqlSelection{
    number?: boolean | number
    title?: boolean | number
    body?: boolean | number
    url?: boolean | number
    createdAt?: boolean | number
    state?: boolean | number
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
    


    const IssueConnection_possibleTypes: string[] = ['IssueConnection']
    export const isIssueConnection = (obj?: { __typename?: any } | null): obj is IssueConnection => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isIssueConnection"')
      return IssueConnection_possibleTypes.includes(obj.__typename)
    }
    


    const PageInfo_possibleTypes: string[] = ['PageInfo']
    export const isPageInfo = (obj?: { __typename?: any } | null): obj is PageInfo => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isPageInfo"')
      return PageInfo_possibleTypes.includes(obj.__typename)
    }
    


    const Issue_possibleTypes: string[] = ['Issue']
    export const isIssue = (obj?: { __typename?: any } | null): obj is Issue => {
      if (!obj?.__typename) throw new Error('__typename is missing in "isIssue"')
      return Issue_possibleTypes.includes(obj.__typename)
    }
    

export const enumIssueState = {
   OPEN: 'OPEN' as const,
   CLOSED: 'CLOSED' as const
}
