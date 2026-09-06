/* Durable-IO helpers shared by the CLI and the AgentCore service. Every
 * lesson from the PR #4/#7 review sagas lives here once: atomic writes
 * (temp + fsync + rename + dir fsync), durable directory creation, O_EXCL
 * run reservation (never auto-reclaimed), and slug validation. */
import { mkdirSync, openSync, writeSync, closeSync, renameSync, fsyncSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { RunState } from './types'

/** Durable atomic write: temp file + fsync + rename + directory fsync, so
 * neither a process crash nor power loss can leave state truncated. */
export function writeDurableJson(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(value, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
  syncDir(path.dirname(filePath))
}

export function syncDir(dir: string): void {
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** Durable directory creation: fsync the parent's entry too, so power loss
 * cannot discard the just-created directory and everything inside it. */
export function mkdirDurable(dir: string): void {
  mkdirSync(dir, { recursive: true })
  syncDir(path.dirname(dir))
}

/** Permanent O_EXCL reservation — existing reservations (including dead or
 * incomplete holders) fail closed. PID death never authorizes takeover. */
export function reserveExclusive(filePath: string): boolean {
  let fd: number
  try { fd = openSync(filePath, 'wx') } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try { writeSync(fd, JSON.stringify({ holderPid: process.pid, acquiredAt: new Date().toISOString() })) }
  finally { closeSync(fd) }
  return true
}

export function loadRunState(stateFile: string): RunState | null {
  if (!existsSync(stateFile)) return null
  return JSON.parse(readFileSync(stateFile, 'utf8')) as RunState
}

export function saveRunState(stateFile: string, state: RunState): void {
  writeDurableJson(stateFile, state)
}

/** Tags/paths become filesystem path segments — they must be safe slugs. */
export function assertSafeSlug(tag: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) {
    throw new Error(`INVALID_${label}: must be a filename-safe slug (letters, digits, . _ -; max 64 chars): "${tag.slice(0, 24)}"`)
  }
}
