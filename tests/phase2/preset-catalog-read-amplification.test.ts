import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 读取次数属于仓储 interface 的性能特征，因此这里监视真实文件系统与 YAML 解析入口，
// 断言「每个预设文档只被读取一次、只被解析一次」这条不变式，而不是断言实现细节。
const bodyReads: string[] = []
const syntaxTreeParses: string[] = []
const plainParses: string[] = []

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    async open(...args: Parameters<typeof original.open>) {
      const handle = await original.open(...args)
      const readFile = handle.readFile.bind(handle)
      return Object.assign(handle, {
        readFile(...readArgs: Parameters<typeof handle.readFile>) {
          bodyReads.push(String(args[0]))
          return readFile(...readArgs)
        },
      })
    },
  }
})

vi.mock('yaml', async (importOriginal) => {
  const original = await importOriginal<typeof import('yaml')>()
  const classify = (options: unknown) => (
    (options as { keepSourceTokens?: boolean } | undefined)?.keepSourceTokens ? syntaxTreeParses : plainParses
  )
  return {
    ...original,
    parseDocument(source: string, options?: Parameters<typeof original.parseDocument>[1]) {
      classify(options).push(source)
      return original.parseDocument(source, options)
    },
    parseAllDocuments(source: string, options?: Parameters<typeof original.parseAllDocuments>[1]) {
      classify(options).push(source)
      return original.parseAllDocuments(source, options)
    },
    // `parse` 交出的是 JS 值而不是语法树，因此它永远算一次普通解析：
    // 「不再运行普通 YAML 解析」这条守卫必须覆盖它，否则换个入口重新解析一遍也能全绿。
    parse(source: string, ...rest: unknown[]) {
      plainParses.push(source)
      return (original.parse as (...args: unknown[]) => unknown)(source, ...rest)
    },
  }
})

const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
const yaml = await import('yaml')
const { SandboxModelRequestStore } = await import('../src/model-request')
const { FileSystemPresetRepository, SandboxPresetService } = await import('../src/presets')

const temporaryDirectories: string[] = []

function coreSource(keyword: string) {
  return `keywords:\n  - ${keyword}\nprompts:\n  - role: system\n    content: "Hello {name}."\n`
}

function characterSource(name: string) {
  return `name: ${name}\nsystem: "You are {name}."\ninput: "Say {prompt}."\n`
}

async function createRoots() {
  const baseDir = await mkdtemp(join(tmpdir(), 'chatluna-sandbox-preset-reads-'))
  temporaryDirectories.push(baseDir)
  const coreRoot = join(baseDir, 'data/chathub/presets')
  const characterRoot = join(baseDir, 'data/chathub/character/presets')
  await mkdir(coreRoot, { recursive: true })
  await mkdir(characterRoot, { recursive: true })
  return { baseDir, coreRoot, characterRoot }
}

function presetBodyReads() {
  // 仓储读取的是根目录 realpath 下的文件，临时目录在 macOS 上会解析出 /private 前缀，因此只比较文件名。
  return bodyReads.filter((path) => path.endsWith('.yml')).map((path) => basename(path))
}

beforeEach(() => {
  bodyReads.length = 0
  syntaxTreeParses.length = 0
  plainParses.length = 0
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('预设目录读取放大', () => {
  it('仓储读取目录时对每个预设文档只读一次正文、只建一次带位置映射的语法树', async () => {
    const { coreRoot, characterRoot } = await createRoots()
    await writeFile(join(coreRoot, 'a.yml'), coreSource('alpha'))
    await writeFile(join(coreRoot, 'b.yml'), coreSource('beta'))
    await writeFile(join(coreRoot, 'c.yml'), coreSource('gamma'))
    const repository = new FileSystemPresetRepository({ coreRoot, characterRoot })
    bodyReads.length = 0
    syntaxTreeParses.length = 0
    plainParses.length = 0

    const files = await repository.readAll('core')

    expect(files).toHaveLength(3)
    expect(presetBodyReads()).toEqual(['a.yml', 'b.yml', 'c.yml'])
    expect(syntaxTreeParses).toHaveLength(3)
    expect(plainParses).toEqual([])
    // 读取一次就要交出完整内容，否则调用方只能再读一遍。
    expect(files.every(({ source, document }) => source.length > 0 && document.expressions.length === 1)).toBe(true)
  })

  it('服务读取目录时读取次数与解析次数都等于预设文档数量，且不再跑普通 YAML 解析', async () => {
    const { baseDir, coreRoot, characterRoot } = await createRoots()
    await writeFile(join(coreRoot, 'core-one.yml'), coreSource('one'))
    await writeFile(join(coreRoot, 'core-two.yml'), coreSource('two'))
    await writeFile(join(characterRoot, 'alice.yml'), characterSource('Alice'))
    await writeFile(join(characterRoot, 'bob.yml'), characterSource('Bob'))
    const service = new SandboxPresetService({ baseDir, mainModelRequests: new SandboxModelRequestStore() })
    bodyReads.length = 0
    syntaxTreeParses.length = 0
    plainParses.length = 0

    const catalog = await service.catalog()

    expect(catalog).toHaveLength(4)
    expect(presetBodyReads()).toHaveLength(4)
    expect(syntaxTreeParses).toHaveLength(4)
    // 展示名称是解析产物，不再由服务层独立解析一遍。
    expect(plainParses).toEqual([])
    expect(catalog.map(({ displayName }) => displayName)).toEqual(['Alice', 'Bob', 'one', 'two'])
  })

  it('监视手段本身能捕获读取与解析：单文档读取恰好一次正文读取加一次语法树解析', async () => {
    const { coreRoot, characterRoot } = await createRoots()
    await writeFile(join(coreRoot, 'single.yml'), coreSource('single'))
    const repository = new FileSystemPresetRepository({ coreRoot, characterRoot })
    bodyReads.length = 0
    syntaxTreeParses.length = 0
    plainParses.length = 0

    await repository.read('core', 'single.yml')

    expect(presetBodyReads()).toEqual(['single.yml'])
    expect(syntaxTreeParses).toHaveLength(1)
    expect(plainParses).toEqual([])

    // 「普通解析次数为 0」只有在监视真的能捕获普通解析时才有意义。
    yaml.parse('probe: 1')
    yaml.parseDocument('probe: 1')
    expect(plainParses).toEqual(['probe: 1', 'probe: 1'])
    expect(syntaxTreeParses).toHaveLength(1)
  })
})
