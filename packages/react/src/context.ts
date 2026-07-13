import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { ChronologClient } from '@chronolog/client'

const ChronologContext = createContext<ChronologClient | undefined>(undefined)

export interface ChronologProviderProps {
  readonly client: ChronologClient
  readonly children?: ReactNode
}

export function ChronologProvider({ client, children }: ChronologProviderProps) {
  return createElement(ChronologContext.Provider, { value: client }, children)
}

export function useChronologClient(override?: ChronologClient): ChronologClient {
  const client = useContext(ChronologContext)
  if (override !== undefined) return override
  if (client === undefined) {
    throw new Error('Chronolog hooks must be rendered inside <ChronologProvider>')
  }
  return client
}
