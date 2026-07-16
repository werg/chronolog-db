#!/usr/bin/env node
/* global process */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'))
if (manifest.format !== 'chronolog-native-distribution-v1' || !Array.isArray(manifest.files)) {
  throw new Error('DISTRIBUTION_MANIFEST_INVALID')
}
const expected = new Map(manifest.files.map((file) => [file.path, file]))
const actual = new Map()
await walk(root)
for (const [path, file] of expected) {
  const found = actual.get(path)
  if (found === undefined || found.sha256 !== file.sha256 || found.bytes !== file.bytes) {
    throw new Error(`DISTRIBUTION_FILE_MISMATCH:${path}`)
  }
}
for (const path of actual.keys()) if (!expected.has(path)) throw new Error(`DISTRIBUTION_UNEXPECTED_FILE:${path}`)
process.stdout.write(`${JSON.stringify({ valid: true, files: expected.size, sourceCommit: manifest.sourceCommit })}\n`)

async function walk(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const name = relative(root, child).split('\\').join('/')
    if (name === 'release-manifest.json') continue
    if (entry.isDirectory()) await walk(child)
    else if (entry.isFile()) {
      const value = await readFile(child)
      actual.set(name, { sha256: createHash('sha256').update(value).digest('hex'), bytes: value.byteLength })
    } else if (entry.isSymbolicLink()) {
      const target = resolve(dirname(child), await readlink(child))
      if (!target.startsWith(`${root}/`)) throw new Error(`DISTRIBUTION_SYMLINK_ESCAPE:${name}`)
      await lstat(target)
    } else throw new Error(`DISTRIBUTION_FILE_TYPE_INVALID:${name}`)
  }
}
