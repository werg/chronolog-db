export interface TransportRecord {
  readonly id: string
  readonly author: string
  readonly sequence: bigint
  readonly previous?: string
  readonly receivedAtMs: number
  readonly payload: Uint8Array
}

export interface PublishOptions {
  readonly timestampMs?: number
}

export interface TransportStatus {
  readonly identity: string
  readonly records: number
  readonly closed: boolean
  readonly peers: readonly string[]
}

export interface ChronologTransport {
  readonly identity: string
  publish(payload: Uint8Array, options?: PublishOptions): Promise<TransportRecord>
  get(id: string): Promise<TransportRecord | undefined>
  history(): Promise<readonly TransportRecord[]>
  subscribe(signal?: AbortSignal): AsyncIterable<TransportRecord>
  status(): Promise<TransportStatus>
  close(): Promise<void>
}

export function cloneRecord(record: TransportRecord): TransportRecord {
  return {
    ...record,
    payload: record.payload.slice(),
  }
}
