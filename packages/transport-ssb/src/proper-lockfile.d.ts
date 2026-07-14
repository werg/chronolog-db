declare module 'proper-lockfile' {
  export interface LockOptions {
    readonly realpath?: boolean
    readonly stale?: number
    readonly update?: number
    readonly retries?: number | {
      readonly retries: number
      readonly factor?: number
      readonly minTimeout?: number
      readonly maxTimeout?: number
      readonly randomize?: boolean
    }
  }

  export function lock(path: string, options?: LockOptions): Promise<() => Promise<void>>
}
