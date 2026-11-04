import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { parsePresetSourceDocument } from './source-document'
import type { PresetDocumentKind, PresetSourceDocument } from './types'

export type PresetRepositoryErrorCode =
  | 'already-exists'
  | 'confirmation-required'
  | 'invalid-file-name'
  | 'not-found'
  | 'revision-conflict'
  | 'unsafe-file'
  | 'unsafe-root'

export class PresetRepositoryError extends Error {
  readonly name = 'PresetRepositoryError'

  constructor(readonly code: PresetRepositoryErrorCode, message: string, readonly cause?: unknown) {
    super(message)
  }
}

export interface PresetRepositoryRoots {
  coreRoot: string
  characterRoot: string
}

export interface PresetFile {
  kind: PresetDocumentKind
  fileName: string
  revision: string
  size: number
  modifiedAt: string
  source: string
  document: PresetSourceDocument
}

export interface CreatePresetInput {
  kind: PresetDocumentKind
  fileName: string
  source: string
}

export interface SavePresetInput extends CreatePresetInput {
  expectedRevision: string
}

export interface RenamePresetInput {
  kind: PresetDocumentKind
  fileName: string
  newFileName: string
  expectedRevision: string
  confirmed: boolean
}

export interface DeletePresetInput {
  kind: PresetDocumentKind
  fileName: string
  expectedRevision: string
  confirmed: boolean
}

export interface PresetRepository {
  readAll(kind: PresetDocumentKind): Promise<PresetFile[]>
  read(kind: PresetDocumentKind, fileName: string): Promise<PresetFile>
  create(input: CreatePresetInput): Promise<PresetFile>
  save(input: SavePresetInput): Promise<PresetFile>
  rename(input: RenamePresetInput): Promise<PresetFile>
  delete(input: DeletePresetInput): Promise<void>
}

export interface FileSystemPresetRepositoryOptions {
  beforeMutationCommit?: (context: {
    operation: 'create' | 'save' | 'rename' | 'delete'
    sourcePath?: string
    destinationPath?: string
  }) => Promise<void> | void
}

interface RootState {
  configuredPath: string
  realPath: string
}

interface FileIdentity {
  dev: bigint
  ino: bigint
}

interface RegularFileSnapshot {
  source: string
  revision: string
  identity: FileIdentity
  modifiedAt: string
}

const mutationQueues = new Map<string, Promise<void>>()

export class FileSystemPresetRepository implements PresetRepository {
  private readonly rootPaths: Record<PresetDocumentKind, string>
  private roots?: Promise<Record<PresetDocumentKind, RootState>>

  constructor(roots: PresetRepositoryRoots, private readonly options: FileSystemPresetRepositoryOptions = {}) {
    this.rootPaths = {
      core: resolve(roots.coreRoot),
      character: resolve(roots.characterRoot),
    }
  }

  async readAll(kind: PresetDocumentKind): Promise<PresetFile[]> {
    const root = await this.requireRoot(kind)
    const entries = await readdir(root.realPath, { withFileTypes: true })
    const files: PresetFile[] = []
    for (const entry of entries) {
      if (!entry.name.endsWith('.yml') || !entry.isFile()) continue
      try {
        // 串行读取：不安全文件靠异常跳过，改成并发就得把跳过改写成结果过滤。
        files.push(await this.readPresetFile(root, kind, entry.name))
      } catch (error) {
        if (error instanceof PresetRepositoryError && error.code === 'unsafe-file') continue
        throw error
      }
    }
    return files.sort((left, right) => left.fileName.localeCompare(right.fileName))
  }

  async read(kind: PresetDocumentKind, fileName: string): Promise<PresetFile> {
    return this.readPresetFile(await this.requireRoot(kind), kind, fileName)
  }

  async create(input: CreatePresetInput): Promise<PresetFile> {
    const root = await this.requireRoot(input.kind)
    const path = this.filePath(root, input.fileName)
    return withMutationLocks([path], async () => {
      await this.assertDestinationMissing(path)
      await this.atomicWrite(path, input.source, true, async () => {
        await this.beforeMutationCommit('create', undefined, path)
        await this.revalidateRoot(root)
        await this.assertDestinationMissing(path)
      })
      const snapshot = await this.readRegularFileSnapshot(path)
      return this.toPresetFile(input.kind, input.fileName, snapshot.source, snapshot.modifiedAt)
    })
  }

  async save(input: SavePresetInput): Promise<PresetFile> {
    const root = await this.requireRoot(input.kind)
    const path = this.filePath(root, input.fileName)
    return withMutationLocks([path], async () => {
      const original = await this.readRegularFileAfterRevision(path, input.expectedRevision)
      if (original.revision === revisionOf(input.source)) {
        return this.toPresetFile(input.kind, input.fileName, original.source, original.modifiedAt)
      }
      await this.atomicWrite(path, input.source, false, async () => {
        await this.beforeMutationCommit('save', path, path)
        await this.revalidateRoot(root)
        await this.revalidateSnapshot(path, original, input.expectedRevision)
      })
      const saved = await this.readRegularFileSnapshot(path)
      return this.toPresetFile(input.kind, input.fileName, saved.source, saved.modifiedAt)
    })
  }

  async rename(input: RenamePresetInput): Promise<PresetFile> {
    this.requireConfirmation(input.confirmed)
    const root = await this.requireRoot(input.kind)
    const sourcePath = this.filePath(root, input.fileName)
    const destinationPath = this.filePath(root, input.newFileName)
    if (sourcePath === destinationPath) {
      return withMutationLocks([sourcePath], async () => {
        const snapshot = await this.readRegularFileAfterRevision(sourcePath, input.expectedRevision)
        return this.toPresetFile(input.kind, input.fileName, snapshot.source, snapshot.modifiedAt)
      })
    }

    return withMutationLocks([sourcePath, destinationPath], async () => {
      const original = await this.readRegularFileAfterRevision(sourcePath, input.expectedRevision)
      await this.assertDestinationMissing(destinationPath)
      await this.beforeMutationCommit('rename', sourcePath, destinationPath)
      await this.revalidateRoot(root)
      await this.revalidateSnapshot(sourcePath, original, input.expectedRevision)
      await this.assertDestinationMissing(destinationPath)

      let destinationIdentity: FileIdentity | undefined
      try {
        await link(sourcePath, destinationPath)
        const destination = await this.readRegularFileSnapshot(destinationPath)
        destinationIdentity = destination.identity
        this.assertSameSnapshot(destinationPath, destination, original, input.expectedRevision)
        await this.revalidateSnapshot(sourcePath, original, input.expectedRevision)
        await unlink(sourcePath)
      } catch (error) {
        if (destinationIdentity) await removeIfIdentity(destinationPath, destinationIdentity)
        throw normalizeFileSystemError(error, input.fileName)
      }
      const renamed = await this.readRegularFileSnapshot(destinationPath)
      return this.toPresetFile(input.kind, input.newFileName, renamed.source, renamed.modifiedAt)
    })
  }

  async delete(input: DeletePresetInput): Promise<void> {
    this.requireConfirmation(input.confirmed)
    const root = await this.requireRoot(input.kind)
    const path = this.filePath(root, input.fileName)
    await withMutationLocks([path], async () => {
      const original = await this.readRegularFileAfterRevision(path, input.expectedRevision)
      await this.beforeMutationCommit('delete', path)
      await this.revalidateRoot(root)
      await this.revalidateSnapshot(path, original, input.expectedRevision)
      try {
        await unlink(path)
      } catch (error) {
        throw normalizeFileSystemError(error, input.fileName)
      }
    })
  }

  private async initializeRoots(): Promise<Record<PresetDocumentKind, RootState>> {
    const core = await this.initializeRoot(this.rootPaths.core)
    const character = await this.initializeRoot(this.rootPaths.character)
    return { core, character }
  }

  private async initializeRoot(configuredPath: string): Promise<RootState> {
    await mkdir(configuredPath, { recursive: true })
    const stats = await lstat(configuredPath)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new PresetRepositoryError('unsafe-root', `预设根目录不安全：${configuredPath}`)
    return { configuredPath, realPath: await realpath(configuredPath) }
  }

  private async requireRoot(kind: PresetDocumentKind): Promise<RootState> {
    const roots = await (this.roots ??= this.initializeRoots())
    const root = roots[kind]
    await this.revalidateRoot(root)
    return root
  }

  private async revalidateRoot(root: RootState): Promise<void> {
    let stats
    let currentRealPath
    try {
      stats = await lstat(root.configuredPath)
      currentRealPath = await realpath(root.configuredPath)
    } catch (error) {
      throw new PresetRepositoryError('unsafe-root', `预设根目录不可用：${root.configuredPath}`, error)
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || currentRealPath !== root.realPath) {
      throw new PresetRepositoryError('unsafe-root', `预设根目录已被替换：${root.configuredPath}`)
    }
  }

  private filePath(root: RootState, fileName: string): string {
    validateFileName(fileName)
    const path = join(root.realPath, fileName)
    if (dirname(path) !== root.realPath) throw new PresetRepositoryError('invalid-file-name', `无效预设文件名：${fileName}`)
    return path
  }

  private async readPresetFile(root: RootState, kind: PresetDocumentKind, fileName: string): Promise<PresetFile> {
    const snapshot = await this.readRegularFileSnapshot(this.filePath(root, fileName))
    return this.toPresetFile(kind, fileName, snapshot.source, snapshot.modifiedAt)
  }

  private async readRegularFileSnapshot(path: string): Promise<RegularFileSnapshot> {
    let handle
    try {
      const before = await lstat(path, { bigint: true })
      if (before.isSymbolicLink() || !before.isFile()) throw new PresetRepositoryError('unsafe-file', `预设不是普通文件：${basename(path)}`)
      handle = await open(path, constants.O_RDONLY | noFollowFlag())
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile()) throw new PresetRepositoryError('unsafe-file', `预设不是普通文件：${basename(path)}`)
      const identity = identityOf(opened)
      if (!sameIdentity(identityOf(before), identity)) throw this.fileReplaced(path)
      const source = await handle.readFile({ encoding: 'utf8' })
      const after = await lstat(path, { bigint: true })
      if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(identityOf(after), identity)) throw this.fileReplaced(path)
      return {
        source,
        revision: revisionOf(source),
        identity,
        modifiedAt: new Date(Number(opened.mtimeMs)).toISOString(),
      }
    } catch (error) {
      throw normalizeFileSystemError(error, basename(path))
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async readRegularFileAfterRevision(path: string, expectedRevision: string): Promise<RegularFileSnapshot> {
    const snapshot = await this.readRegularFileSnapshot(path)
    if (snapshot.revision !== expectedRevision) throw this.revisionConflict(basename(path))
    return snapshot
  }

  private async revalidateSnapshot(path: string, original: RegularFileSnapshot, expectedRevision: string): Promise<void> {
    const current = await this.readRegularFileSnapshot(path)
    this.assertSameSnapshot(path, current, original, expectedRevision)
  }

  private assertSameSnapshot(path: string, current: RegularFileSnapshot, original: RegularFileSnapshot, expectedRevision: string): void {
    if (!sameIdentity(current.identity, original.identity)) throw this.fileReplaced(path)
    if (current.revision !== expectedRevision) throw this.revisionConflict(basename(path))
  }

  private async assertDestinationMissing(path: string): Promise<void> {
    try {
      await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw normalizeFileSystemError(error, basename(path))
    }
    throw new PresetRepositoryError('already-exists', `预设已存在：${basename(path)}`)
  }

  private async atomicWrite(path: string, source: string, createOnly: boolean, beforeCommit: () => Promise<void>): Promise<void> {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
      await handle.writeFile(source, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await beforeCommit()
      if (createOnly) {
        await link(temporaryPath, path)
        await unlink(temporaryPath)
      } else {
        await rename(temporaryPath, path)
      }
    } catch (error) {
      throw normalizeFileSystemError(error, basename(path))
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async beforeMutationCommit(
    operation: 'create' | 'save' | 'rename' | 'delete',
    sourcePath?: string,
    destinationPath?: string,
  ): Promise<void> {
    await this.options.beforeMutationCommit?.({ operation, sourcePath, destinationPath })
  }

  private toPresetFile(kind: PresetDocumentKind, fileName: string, source: string, modifiedAt: string): PresetFile {
    return {
      kind,
      fileName,
      source,
      revision: revisionOf(source),
      size: Buffer.byteLength(source),
      modifiedAt,
      document: parsePresetSourceDocument(kind, source),
    }
  }

  private requireConfirmation(confirmed: boolean): void {
    if (!confirmed) throw new PresetRepositoryError('confirmation-required', '重命名或删除预设需要显式确认')
  }

  private revisionConflict(fileName: string): PresetRepositoryError {
    return new PresetRepositoryError('revision-conflict', `预设已被其他操作修改：${fileName}`)
  }

  private fileReplaced(path: string): PresetRepositoryError {
    return new PresetRepositoryError('unsafe-file', `预设文件已被替换：${basename(path)}`)
  }
}

async function withMutationLocks<T>(paths: string[], action: () => Promise<T>): Promise<T> {
  const releases: Array<() => void> = []
  try {
    for (const path of [...new Set(paths)].sort()) releases.push(await acquireMutationLock(path))
    return await action()
  } finally {
    for (const release of releases.reverse()) release()
  }
}

async function acquireMutationLock(path: string): Promise<() => void> {
  const previous = mutationQueues.get(path) ?? Promise.resolve()
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  const tail = previous.catch(() => undefined).then(() => gate)
  mutationQueues.set(path, tail)
  await previous.catch(() => undefined)
  return () => {
    if (mutationQueues.get(path) === tail) mutationQueues.delete(path)
    releaseGate()
  }
}

async function removeIfIdentity(path: string, identity: FileIdentity): Promise<void> {
  try {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isSymbolicLink() && stats.isFile() && sameIdentity(identityOf(stats), identity)) await unlink(path)
  } catch {
    // Best-effort cleanup must never remove a path that another actor replaced.
  }
}

function identityOf(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function validateFileName(fileName: string): void {
  if (!fileName || fileName !== basename(fileName) || isAbsolute(fileName) || normalize(fileName) !== fileName || fileName.includes('/') || fileName.includes('\\') || !fileName.endsWith('.yml') || fileName === '.yml' || fileName.includes('\0')) {
    throw new PresetRepositoryError('invalid-file-name', `无效预设文件名：${fileName}`)
  }
}

function revisionOf(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function normalizeFileSystemError(error: unknown, fileName: string): PresetRepositoryError {
  if (error instanceof PresetRepositoryError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return new PresetRepositoryError('not-found', `预设不存在：${fileName}`, error)
  if (code === 'EEXIST') return new PresetRepositoryError('already-exists', `预设已存在：${fileName}`, error)
  if (code === 'ELOOP') return new PresetRepositoryError('unsafe-file', `拒绝访问 symlink 预设：${fileName}`, error)
  return new PresetRepositoryError('unsafe-file', `无法安全访问预设：${fileName}`, error)
}
