import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { CONSUMPTION_TABLE_SQL, LOCAL_OWNER_TABLES_SQL } from './store-schema'

export const STORE_ADMISSION_SCHEMA = 'who-decides.local-store-admission.v1' as const
export const LOCAL_OWNER_WRITER_VERSION = '0.1.0'
export const LEGACY_CONSUMPTION_WRITER_VERSION = '0.1.0'

export type WriterAdmission = {
  role: string
  version: string
  insertionPath: string
}

export type StoreAdmission = {
  schema: typeof STORE_ADMISSION_SCHEMA
  canonicalPath: string
  databaseId: string
  device: string
  inode: string
  filesystemType: string
  schemaSha256: string
  configGeneration: string
  journalMode: 'wal'
  synchronous: 'full'
  lockingMode: 'normal'
  writers: WriterAdmission[]
  guardDirectory: string
  guardDevice: string
  guardInode: string
  guardFilesystemType: string
  /** sha256 of the random generation token held in the guard-directory
   * sidecar. The token lives OUTSIDE the copyable database bytes, so a
   * database replaced by a byte-clone cannot satisfy admission without the
   * pinned guard directory's sidecar as well (review P1: inode-reuse). */
  generationTokenDigest: string
  generationSidecarDevice: string
  generationSidecarInode: string
  /** The anchor subdirectory holds the generation sidecar and a HARDLINK to
   * the admitted database. The hardlink keeps the original inode ALIVE, so
   * a replacement file can never reuse its inode number while the anchor
   * exists; deleting or recreating anchor entries changes the anchor
   * directory's ctime, which is pinned here (ctime is not settable). */
  anchorDirectory: string
  anchorDevice: string
  anchorInode: string
  anchorCtime: string
}

const ADMISSION_SQL = `
  CREATE TABLE IF NOT EXISTS owner_store_admission (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    database_id TEXT NOT NULL,
    config_generation TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS owner_writer_attestations (
    role TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    insertion_path TEXT NOT NULL,
    config_generation TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL
  );
`

const fail = (detail: string): never => { throw new Error(`OWNER_STORE_ADMISSION_FAILED: ${detail}`) }
const isUnsafePath = (dbPath: string) => !path.isAbsolute(dbPath) || dbPath === ':memory:' || dbPath.startsWith('file:') || /[?\0]/.test(dbPath)
const physicalIdentity = (dbPath: string) => {
  const stat = statSync(dbPath, { bigint: true })
  const fs = statfsSync(dbPath, { bigint: true })
  return { device: stat.dev.toString(), inode: stat.ino.toString(), filesystemType: fs.type.toString() }
}
const schemaFingerprint = (db: Database.Database) => createHash('sha256').update(JSON.stringify(
  db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all(),
)).digest('hex')
const normalizeWriter = (writer: WriterAdmission): WriterAdmission => ({ role: writer.role, version: writer.version, insertionPath: writer.insertionPath })
const sortedWriters = (writers: WriterAdmission[]) => writers.map(normalizeWriter).sort((a, b) => a.role.localeCompare(b.role))
const manifestPayload = (admission: StoreAdmission) => JSON.stringify({
  schema: admission.schema,
  canonicalPath: admission.canonicalPath,
  databaseId: admission.databaseId,
  device: admission.device,
  inode: admission.inode,
  filesystemType: admission.filesystemType,
  schemaSha256: admission.schemaSha256,
  configGeneration: admission.configGeneration,
  journalMode: admission.journalMode,
  synchronous: admission.synchronous,
  lockingMode: admission.lockingMode,
  writers: sortedWriters(admission.writers),
  guardDirectory: admission.guardDirectory,
  guardDevice: admission.guardDevice,
  guardInode: admission.guardInode,
  guardFilesystemType: admission.guardFilesystemType,
  generationTokenDigest: admission.generationTokenDigest,
  generationSidecarDevice: admission.generationSidecarDevice,
  generationSidecarInode: admission.generationSidecarInode,
  anchorDirectory: admission.anchorDirectory,
  anchorDevice: admission.anchorDevice,
  anchorInode: admission.anchorInode,
  anchorCtime: admission.anchorCtime
})
export const storeAdmissionDigest = (admission: StoreAdmission) => createHash('sha256').update(manifestPayload(admission)).digest('hex')

function validateWriterInventory(writers: WriterAdmission[]) {
  if (writers.length === 0) fail('writer inventory is empty')
  const roles = new Set<string>()
  for (const writer of writers) {
    if (!writer.role || !writer.version || !writer.insertionPath || roles.has(writer.role)) fail('writer inventory is not closed and unique')
    roles.add(writer.role)
  }
}

/** Explicit owner-only bootstrap. It creates both schemas and pins database
 * identity before any admitted writer is allowed to start. */
export function bootstrapOwnerAdmittedStore(input: { dbPath: string, configGeneration: string, writers: WriterAdmission[], approvedFilesystemTypes: string[] }): StoreAdmission {
  if (isUnsafePath(input.dbPath) || existsSync(input.dbPath)) fail('bootstrap requires a new absolute local database path')
  if (!input.configGeneration) fail('config generation is required')
  validateWriterInventory(input.writers)
  mkdirSync(path.dirname(input.dbPath), { recursive: true })
  const requestedPath = path.resolve(input.dbPath)
  const parentFilesystemType = statfsSync(path.dirname(requestedPath), { bigint: true }).type.toString()
  if (!input.approvedFilesystemTypes.includes(parentFilesystemType)) fail('filesystem type is not owner-approved for reliable local SQLite locking')
  const databaseId = randomUUID()
  const descriptor = openSync(requestedPath, 'wx', 0o600)
  let db: Database.Database | undefined
  try {
    const created = fstatSync(descriptor, { bigint: true })
    db = new Database(requestedPath, { fileMustExist: true })
    const openedIdentity = physicalIdentity(requestedPath)
    if (openedIdentity.device !== created.dev.toString() || openedIdentity.inode !== created.ino.toString()) fail('exclusively created bootstrap target was replaced before SQLite open')
    if (String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase() !== 'wal') fail('WAL journal mode unavailable')
    db.pragma('synchronous = FULL')
    db.pragma('locking_mode = NORMAL')
    db.exec(`${ADMISSION_SQL}\n${CONSUMPTION_TABLE_SQL};\n${LOCAL_OWNER_TABLES_SQL}`)
    const canonicalPath = realpathSync(requestedPath)
    const identity = physicalIdentity(canonicalPath)
    if (!input.approvedFilesystemTypes.includes(identity.filesystemType)) fail('database filesystem type changed during bootstrap')
    const guardDirectory = path.join(path.dirname(canonicalPath), `.who-decides-guards-${databaseId}`)
    mkdirSync(guardDirectory, { recursive: false })
    const guardIdentity = physicalIdentity(guardDirectory)
    const anchorDirectory = path.join(guardDirectory, 'anchor')
    mkdirSync(anchorDirectory, { recursive: false })
    const generationPath = path.join(anchorDirectory, 'generation')
    const generationToken = randomUUID() + randomUUID()
    const sidecarDescriptor = openSync(generationPath, 'wx')
    try { writeSync(sidecarDescriptor, generationToken) } finally { closeSync(sidecarDescriptor) }
    const generationTokenDigest = createHash('sha256').update(generationToken).digest('hex')
    const sidecarIdentity = physicalIdentity(generationPath)
    // Hardlink the database into the anchor: the original inode can never be
    // freed (and its number never reused) while this link exists.
    linkSync(canonicalPath, path.join(anchorDirectory, 'db-identity'))
    const anchorStat = statSync(anchorDirectory, { bigint: true })
    const base = { schema: STORE_ADMISSION_SCHEMA, canonicalPath, databaseId, ...identity, schemaSha256: schemaFingerprint(db), configGeneration: input.configGeneration, journalMode: 'wal' as const, synchronous: 'full' as const, lockingMode: 'normal' as const, writers: sortedWriters(input.writers) }
    const admission: StoreAdmission = { ...base, guardDirectory, guardDevice: guardIdentity.device, guardInode: guardIdentity.inode, guardFilesystemType: guardIdentity.filesystemType, generationTokenDigest, generationSidecarDevice: sidecarIdentity.device, generationSidecarInode: sidecarIdentity.inode, anchorDirectory, anchorDevice: anchorStat.dev.toString(), anchorInode: anchorStat.ino.toString(), anchorCtime: anchorStat.ctimeNs.toString() }
    const digest = storeAdmissionDigest(admission)
    db.prepare('INSERT INTO owner_store_admission VALUES (1, ?, ?, ?)').run(databaseId, input.configGeneration, digest)
    return admission
  } finally { db?.close(); closeSync(descriptor) }
}

export function openAdmittedStore(dbPath: string, admission: StoreAdmission, writer: WriterAdmission): Database.Database {
  if (!admission || admission.schema !== STORE_ADMISSION_SCHEMA || isUnsafePath(dbPath) || !existsSync(dbPath)) fail('normal startup requires an existing pinned absolute database')
  validateWriterInventory(admission.writers)
  const resolved = realpathSync(dbPath)
  if (dbPath !== admission.canonicalPath || resolved !== admission.canonicalPath) fail('configured path is not the canonical admitted path')
  const identity = physicalIdentity(resolved)
  if (identity.device !== admission.device || identity.inode !== admission.inode || identity.filesystemType !== admission.filesystemType) fail('opened database physical identity drifted')
  const expectedWriter = admission.writers.find(candidate => candidate.role === writer.role)
  if (!expectedWriter || expectedWriter.role !== writer.role || expectedWriter.version !== writer.version || expectedWriter.insertionPath !== writer.insertionPath) fail('writer role, version, or insertion path is unapproved')
  verifyAdmittedGuardDirectory(admission)
  const db = new Database(resolved, { fileMustExist: true })
  try {
    db.pragma('synchronous = FULL')
    db.pragma('locking_mode = NORMAL')
    verifyAdmittedStore(db, admission)
    const digest = storeAdmissionDigest(admission)
    db.prepare('INSERT INTO owner_writer_attestations VALUES (?,?,?,?,?) ON CONFLICT(role) DO UPDATE SET version=excluded.version,insertion_path=excluded.insertion_path,config_generation=excluded.config_generation,manifest_sha256=excluded.manifest_sha256').run(writer.role, writer.version, writer.insertionPath, admission.configGeneration, digest)
    return db
  } catch (error) { db.close(); throw error }
}

/** Read-only verification for the live connection, repeated under each write
 * transaction. Opening a store is not a lifetime admission lease. */
export function verifyAdmittedStore(db: Database.Database, admission: StoreAdmission) {
  if (!admission || admission.schema !== STORE_ADMISSION_SCHEMA || isUnsafePath(admission.canonicalPath)) fail('invalid store admission')
  validateWriterInventory(admission.writers)
  verifyAdmittedGuardDirectory(admission)
  const main = (db.pragma('database_list') as Array<{ name: string, file: string }>).find(row => row.name === 'main')
  if (!main) throw new Error('OWNER_STORE_ADMISSION_FAILED: opened SQLite main database is missing')
  if (realpathSync(main.file) !== admission.canonicalPath) fail('opened SQLite main database does not match admission')
  const openedIdentity = physicalIdentity(main.file)
  if (openedIdentity.device !== admission.device || openedIdentity.inode !== admission.inode || openedIdentity.filesystemType !== admission.filesystemType) fail('opened SQLite main database physical identity drifted')
  if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== admission.journalMode) fail('SQLite journal posture changed')
  if (Number(db.pragma('synchronous', { simple: true })) !== 2 || String(db.pragma('locking_mode', { simple: true })).toLowerCase() !== 'normal') fail('SQLite connection locking posture is not approved')
  if (schemaFingerprint(db) !== admission.schemaSha256) fail('approved store schema generation changed')
  const row = db.prepare('SELECT database_id,config_generation,manifest_sha256 FROM owner_store_admission WHERE singleton=1').get() as { database_id: string, config_generation: string, manifest_sha256: string } | undefined
  const digest = storeAdmissionDigest(admission)
  if (!row || row.database_id !== admission.databaseId || row.config_generation !== admission.configGeneration || row.manifest_sha256 !== digest) fail('persistent database identity or configuration generation does not match')
}

export function requireClosedWriterInventory(db: Database.Database, admission: StoreAdmission) {
  verifyAdmittedStore(db, admission)
  const rows = db.prepare('SELECT role,version,insertion_path,config_generation,manifest_sha256 FROM owner_writer_attestations ORDER BY role').all() as Array<{ role: string, version: string, insertion_path: string, config_generation: string, manifest_sha256: string }>
  const digest = storeAdmissionDigest(admission)
  const actual = rows.map(row => ({ role: row.role, version: row.version, insertionPath: row.insertion_path, configGeneration: row.config_generation, manifestSha256: row.manifest_sha256 }))
  const expected = sortedWriters(admission.writers).map(writer => ({ role: writer.role, version: writer.version, insertionPath: writer.insertionPath, configGeneration: admission.configGeneration, manifestSha256: digest }))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('enabled writer inventory is missing, stale, or unknown')
}

export function admittedGuardPath(admission: StoreAdmission, issuerId: string, decisionId: string) {
  return path.join(admission.guardDirectory, createHash('sha256').update(`${admission.databaseId}\0${issuerId}\0${decisionId}`).digest('hex') + '.guard')
}

export function verifyAdmittedGuardDirectory(admission: StoreAdmission) {
  if (!existsSync(admission.guardDirectory) || realpathSync(admission.guardDirectory) !== admission.guardDirectory) fail('canonical guard directory is missing or aliased')
  const identity = physicalIdentity(admission.guardDirectory)
  if (identity.device !== admission.guardDevice || identity.inode !== admission.guardInode || identity.filesystemType !== admission.guardFilesystemType) fail('canonical guard directory physical identity drifted')
  // Generation anchor: the token lives outside the copyable database bytes,
  // and the db-identity HARDLINK keeps the admitted inode alive — a replaced
  // file can never present the pinned inode number while the anchor exists.
  // Deleting or recreating anchor entries changes the anchor directory's
  // ctime (not settable), so manipulation of the anchor itself is detected.
  if (!existsSync(admission.anchorDirectory) || realpathSync(admission.anchorDirectory) !== admission.anchorDirectory) fail('admission anchor directory is missing or aliased')
  const anchorStat = statSync(admission.anchorDirectory, { bigint: true })
  if (anchorStat.dev.toString() !== admission.anchorDevice || anchorStat.ino.toString() !== admission.anchorInode) fail('admission anchor directory physical identity drifted')
  if (anchorStat.ctimeNs.toString() !== admission.anchorCtime) fail('admission anchor directory changed; the anchor was modified after bootstrap')
  const dbIdentityPath = path.join(admission.anchorDirectory, 'db-identity')
  if (!existsSync(dbIdentityPath)) fail('admission anchor hardlink is missing; the original database inode can no longer be proven alive')
  const hardlinkIdentity = physicalIdentity(dbIdentityPath)
  if (hardlinkIdentity.inode !== admission.inode || hardlinkIdentity.device !== admission.device) fail('admission anchor hardlink does not point at the admitted database inode')
  const generationPath = path.join(admission.anchorDirectory, 'generation')
  if (!existsSync(generationPath)) fail('generation sidecar is missing; the admitted file generation cannot be confirmed')
  const sidecarIdentity = physicalIdentity(generationPath)
  if (sidecarIdentity.device !== admission.generationSidecarDevice || sidecarIdentity.inode !== admission.generationSidecarInode) fail('generation sidecar physical identity drifted; the store was replaced or the sidecar was recreated')
  const token = readFileSync(generationPath, 'utf8')
  if (createHash('sha256').update(token).digest('hex') !== admission.generationTokenDigest) fail('generation token does not match the admitted generation')
}

/** General legacy mode must never be able to open an admitted candidate store
 * without the exact owner admission packet. */
export function rejectUnadmittedAccess(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner_store_admission'").get()) fail('admitted store requires an approved writer configuration')
}
