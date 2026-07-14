import type Docker from 'dockerode'

export interface DockerSystemInfo {
  readonly name: string
  readonly cpus: number
  readonly memoryBytes: number
}

export async function readDockerSystemInfo(docker: Docker): Promise<DockerSystemInfo> {
  const value: unknown = await docker.info()
  if (!isRecord(value) || typeof value.Name !== 'string' ||
      typeof value.NCPU !== 'number' || !Number.isFinite(value.NCPU) ||
      typeof value.MemTotal !== 'number' || !Number.isFinite(value.MemTotal)) {
    throw new Error('DOCKER_SYSTEM_INFO_INVALID')
  }
  return { name: value.Name, cpus: value.NCPU, memoryBytes: value.MemTotal }
}

export async function readDockerPing(docker: Docker): Promise<string> {
  const value: unknown = await docker.ping()
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString()
  throw new Error('DOCKER_PING_INVALID')
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
