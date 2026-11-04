import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSystemPresetRepository, PresetRepositoryError } from '../src/presets'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createRepository(options?: ConstructorParameters<typeof FileSystemPresetRepository>[1]) {
  const base = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-presets-'))
  temporaryDirectories.push(base)
  const coreRoot = join(base, 'data/chathub/presets')
  const characterRoot = join(base, 'data/chathub/character/presets')
  await mkdir(coreRoot, { recursive: true })
  await mkdir(characterRoot, { recursive: true })
  const repository = new FileSystemPresetRepository({ coreRoot, characterRoot }, options)
  return { base, coreRoot, characterRoot, repository }
}

function expectRepositoryError(code: string) {
  return expect.objectContaining({ name: 'PresetRepositoryError', code })
}

describe('文件系统预设仓库', () => {
  it('只读取对应固定根目录中的 .yml 普通文件，按文件名稳定排序并交出完整文档', async () => {
    const { coreRoot, characterRoot, repository } = await createRepository()
    await mkdir(join(coreRoot, 'directory.yml'))
    await writeFile(join(coreRoot, 'z.yml'), 'prompts: []\n')
    await writeFile(join(coreRoot, 'a.yml'), 'keywords:\n  - alpha\nprompts:\n  - content: "Hi {name}"\n')
    await writeFile(join(coreRoot, 'legacy.txt'), 'ignored')
    await writeFile(join(coreRoot, 'other.yaml'), 'ignored')
    await writeFile(join(characterRoot, 'character.yml'), 'system: hi\ninput: there\n')
    await symlink(join(coreRoot, 'a.yml'), join(coreRoot, 'linked.yml'))

    const core = await repository.readAll('core')

    expect(core.map(({ fileName }) => fileName)).toEqual(['a.yml', 'z.yml'])
    expect((await repository.readAll('character')).map(({ fileName }) => fileName)).toEqual(['character.yml'])
    // 按目录读取一次就交出完整内容与解析结果，调用方不需要再按文件名读一遍。
    expect(core[0]).toEqual(await repository.read('core', 'a.yml'))
    expect(core[0]).toEqual(expect.objectContaining({
      source: expect.stringContaining('keywords:'),
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: expect.any(Number),
      modifiedAt: expect.any(String),
      document: expect.objectContaining({
        displayName: 'alpha',
        expressions: [expect.objectContaining({ content: 'name' })],
      }),
    }))
  })

  it('创建和读取时保留原始 YAML，并返回可复查的内容 revision 与语义文档', async () => {
    const { repository } = await createRepository()
    const source = '# comment\nprompts:\n  - content: |\n      Hello {name}\nunknown: true\n'

    const created = await repository.create({ kind: 'core', fileName: 'demo.yml', source })
    const read = await repository.read('core', 'demo.yml')

    expect(created).toEqual(expect.objectContaining({ kind: 'core', fileName: 'demo.yml', source }))
    expect(created.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(read).toEqual(created)
    expect(read.document.source).toBe(source)
    expect(read.document.expressions).toHaveLength(1)
  })

  it('保存使用 revision 做乐观并发控制，冲突失败不改变原文件且不遗留临时文件', async () => {
    const { coreRoot, repository } = await createRepository()
    const initial = await repository.create({ kind: 'core', fileName: 'demo.yml', source: 'prompts: []\n' })
    const saved = await repository.save({
      kind: 'core',
      fileName: 'demo.yml',
      expectedRevision: initial.revision,
      source: '# preserved\nprompts:\n  - content: "{prompt}"\n',
    })

    expect(saved.revision).not.toBe(initial.revision)
    await expect(repository.save({
      kind: 'core',
      fileName: 'demo.yml',
      expectedRevision: initial.revision,
      source: 'must-not-win: true\n',
    })).rejects.toEqual(expectRepositoryError('revision-conflict'))
    expect(await readFile(join(coreRoot, 'demo.yml'), 'utf8')).toBe(saved.source)
    expect(await readdir(coreRoot)).toEqual(['demo.yml'])
  })

  it('并行 mutation 按路径串行化，同一 stale expectedRevision 只有一个保存能成功', async () => {
    const { coreRoot, repository } = await createRepository()
    const initial = await repository.create({ kind: 'core', fileName: 'demo.yml', source: 'version: initial\n' })

    const results = await Promise.allSettled([
      repository.save({ kind: 'core', fileName: 'demo.yml', expectedRevision: initial.revision, source: 'version: first\n' }),
      repository.save({ kind: 'core', fileName: 'demo.yml', expectedRevision: initial.revision, source: 'version: second\n' }),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(({ status }) => status === 'rejected')
    expect(rejected).toEqual(expect.objectContaining({
      status: 'rejected',
      reason: expectRepositoryError('revision-conflict'),
    }))
    expect(['version: first\n', 'version: second\n']).toContain(await readFile(join(coreRoot, 'demo.yml'), 'utf8'))
    expect(await readdir(coreRoot)).toEqual(['demo.yml'])
  })

  it('保存提交前目标被替换为 symlink 时拒绝提交且不触碰 symlink 目标', async () => {
    let reachedCommit!: () => void
    let releaseCommit!: () => void
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve })
    const continueCommit = new Promise<void>((resolve) => { releaseCommit = resolve })
    const { base, coreRoot, repository } = await createRepository({
      beforeMutationCommit: async ({ operation }) => {
        if (operation !== 'save') return
        reachedCommit()
        await continueCommit
      },
    })
    const outside = join(base, 'outside.yml')
    await writeFile(outside, 'outside: unchanged\n')
    const created = await repository.create({ kind: 'core', fileName: 'demo.yml', source: 'version: initial\n' })

    const saving = repository.save({
      kind: 'core',
      fileName: 'demo.yml',
      expectedRevision: created.revision,
      source: 'version: changed\n',
    })
    await atCommit
    await rm(join(coreRoot, 'demo.yml'))
    await symlink(outside, join(coreRoot, 'demo.yml'))
    releaseCommit()

    await expect(saving).rejects.toEqual(expectRepositoryError('unsafe-file'))
    expect(await readFile(outside, 'utf8')).toBe('outside: unchanged\n')
    expect(await readdir(coreRoot)).toEqual(['demo.yml'])
  })

  it('删除提交前普通文件被同 revision 的另一 inode 替换时拒绝删除', async () => {
    let reachedCommit!: () => void
    let releaseCommit!: () => void
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve })
    const continueCommit = new Promise<void>((resolve) => { releaseCommit = resolve })
    const { coreRoot, repository } = await createRepository({
      beforeMutationCommit: async ({ operation }) => {
        if (operation !== 'delete') return
        reachedCommit()
        await continueCommit
      },
    })
    const source = 'same: revision\n'
    const created = await repository.create({ kind: 'core', fileName: 'demo.yml', source })

    const deleting = repository.delete({
      kind: 'core',
      fileName: 'demo.yml',
      expectedRevision: created.revision,
      confirmed: true,
    })
    await atCommit
    // 替换文件必须在原文件还占着 inode 时就建好，再用 rename 原子覆盖过去。
    // 先 rm 释放 inode 再创建，会让文件系统把同一个 inode 号分配回来（ext4 会，APFS 不会），
    // dev+ino 判定就看不出替换，这条断言会只在 Linux 上失败。
    const before = await stat(join(coreRoot, 'demo.yml'))
    await writeFile(join(coreRoot, 'replacement.yml'), source)
    // 守住上面那件事：inode 号真的换了，这条用例才在检验 dev+ino 判定。
    expect((await stat(join(coreRoot, 'replacement.yml'))).ino).not.toBe(before.ino)
    await rename(join(coreRoot, 'replacement.yml'), join(coreRoot, 'demo.yml'))
    releaseCommit()

    await expect(deleting).rejects.toEqual(expectRepositoryError('unsafe-file'))
    expect(await readFile(join(coreRoot, 'demo.yml'), 'utf8')).toBe(source)
  })

  it('重命名提交前源文件被 symlink 替换时拒绝提交且不创建目标', async () => {
    let reachedCommit!: () => void
    let releaseCommit!: () => void
    const atCommit = new Promise<void>((resolve) => { reachedCommit = resolve })
    const continueCommit = new Promise<void>((resolve) => { releaseCommit = resolve })
    const { base, coreRoot, repository } = await createRepository({
      beforeMutationCommit: async ({ operation }) => {
        if (operation !== 'rename') return
        reachedCommit()
        await continueCommit
      },
    })
    const outside = join(base, 'outside.yml')
    await writeFile(outside, 'outside: unchanged\n')
    const created = await repository.create({ kind: 'core', fileName: 'old.yml', source: 'version: initial\n' })

    const renaming = repository.rename({
      kind: 'core',
      fileName: 'old.yml',
      newFileName: 'new.yml',
      expectedRevision: created.revision,
      confirmed: true,
    })
    await atCommit
    await rm(join(coreRoot, 'old.yml'))
    await symlink(outside, join(coreRoot, 'old.yml'))
    releaseCommit()

    await expect(renaming).rejects.toEqual(expectRepositoryError('unsafe-file'))
    expect(await readFile(outside, 'utf8')).toBe('outside: unchanged\n')
    expect(await readdir(coreRoot)).toEqual(['old.yml'])
  })

  it('重命名和删除要求显式确认，不检查或改写上游引用', async () => {
    const { coreRoot, repository } = await createRepository()
    const created = await repository.create({ kind: 'core', fileName: 'old.yml', source: 'marker: old.yml\n' })

    await expect(repository.rename({
      kind: 'core',
      fileName: 'old.yml',
      newFileName: 'new.yml',
      expectedRevision: created.revision,
      confirmed: false,
    })).rejects.toEqual(expectRepositoryError('confirmation-required'))

    const renamed = await repository.rename({
      kind: 'core',
      fileName: 'old.yml',
      newFileName: 'new.yml',
      expectedRevision: created.revision,
      confirmed: true,
    })
    expect(renamed.fileName).toBe('new.yml')
    expect(renamed.source).toBe('marker: old.yml\n')
    expect(await readdir(coreRoot)).toEqual(['new.yml'])

    await expect(repository.delete({
      kind: 'core',
      fileName: 'new.yml',
      expectedRevision: renamed.revision,
      confirmed: false,
    })).rejects.toEqual(expectRepositoryError('confirmation-required'))
    await repository.delete({
      kind: 'core',
      fileName: 'new.yml',
      expectedRevision: renamed.revision,
      confirmed: true,
    })
    expect(await repository.readAll('core')).toEqual([])
  })

  it('拒绝路径穿越、非 .yml 名称、目标碰撞与文件 symlink', async () => {
    const { base, coreRoot, repository } = await createRepository()
    const outside = join(base, 'outside.yml')
    await writeFile(outside, 'outside: unchanged\n')
    await symlink(outside, join(coreRoot, 'linked.yml'))

    await expect(repository.read('core', '../outside.yml')).rejects.toEqual(expectRepositoryError('invalid-file-name'))
    await expect(repository.create({ kind: 'core', fileName: 'wrong.yaml', source: '' })).rejects.toEqual(expectRepositoryError('invalid-file-name'))
    await expect(repository.read('core', 'linked.yml')).rejects.toEqual(expectRepositoryError('unsafe-file'))
    await expect(repository.save({ kind: 'core', fileName: 'linked.yml', expectedRevision: 'x', source: 'changed: true\n' }))
      .rejects.toEqual(expectRepositoryError('unsafe-file'))
    expect(await readFile(outside, 'utf8')).toBe('outside: unchanged\n')

    const first = await repository.create({ kind: 'core', fileName: 'first.yml', source: 'first: true\n' })
    await repository.create({ kind: 'core', fileName: 'second.yml', source: 'second: true\n' })
    await expect(repository.rename({
      kind: 'core',
      fileName: 'first.yml',
      newFileName: 'second.yml',
      expectedRevision: first.revision,
      confirmed: true,
    })).rejects.toEqual(expectRepositoryError('already-exists'))
  })

  it('拒绝被 symlink 替换的固定根目录', async () => {
    const { base, coreRoot, repository } = await createRepository()
    const replacement = join(base, 'replacement')
    await mkdir(replacement)
    await rm(coreRoot, { recursive: true })
    await symlink(replacement, coreRoot)

    await expect(repository.readAll('core')).rejects.toEqual(expectRepositoryError('unsafe-root'))
    expect(await readdir(replacement)).toEqual([])
  })

  it('错误类型公开稳定的机器可读 code', () => {
    const error = new PresetRepositoryError('not-found', 'missing')
    expect(error).toEqual(expect.objectContaining({ name: 'PresetRepositoryError', code: 'not-found', message: 'missing' }))
  })
})
