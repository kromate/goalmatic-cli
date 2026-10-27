/// <reference types="vite/client" />

// Typed boundary for the Goalmatic App runtime globals that the hosted App
// receives from the Builder-injected SDK. Shapes mirror the private
// `@goalmatic/app-sdk` 1.6.1 `src/types.ts` and `src/pagination.ts`
// (Goalmatic-Website-Builder, file revision 22ff2482) and are intentionally
// limited to the members this App uses. Replace with the published SDK
// declarations once they are distributed with the starter.

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, unknown>
  export default component
}

export {}

declare global {
  interface GoalmaticPublicAccount {
    id: string
    [key: string]: unknown
  }

  type GoalmaticUser = Record<string, unknown>

  interface GoalmaticFetchAllRecordOptions {
    cursor?: string
    pageSize?: number
    limit?: number
    maxPages?: number
    maxRecords?: number
    signal?: AbortSignal
  }

  interface GoalmaticRecordRow {
    id: string
    [key: string]: unknown
  }

  interface GoalmaticCompleteRecordCollection {
    success: true
    complete: true
    records: GoalmaticRecordRow[]
    table: unknown
    totalReturned: number
    pagesRead: number
    nextCursor: null
    hasMore: false
  }

  interface GoalmaticExecuteOptions {
    [key: string]: unknown
  }

  interface GoalmaticAuthGlobal {
    readonly account: GoalmaticPublicAccount | null
    readonly user: GoalmaticUser | null
    getUser(force?: boolean): Promise<GoalmaticUser | null>
    isAuthenticated(): boolean
    onAuthChange(listener: (user: GoalmaticUser | null) => void): () => void
  }

  interface GoalmaticDataGlobal {
    fetchAll(tableId: string, options?: Record<string, unknown> & GoalmaticFetchAllRecordOptions): Promise<GoalmaticCompleteRecordCollection>
    submit(tableId: string, data: unknown, options?: GoalmaticExecuteOptions): Promise<unknown>
    update(tableId: string, recordId: string, data: unknown, options?: GoalmaticExecuteOptions): Promise<unknown>
    remove(tableId: string, recordId: string, options?: GoalmaticExecuteOptions): Promise<unknown>
  }

  interface Window {
    GoalmaticAuth?: GoalmaticAuthGlobal
    GoalmaticData?: GoalmaticDataGlobal
  }
}
