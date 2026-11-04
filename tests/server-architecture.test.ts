import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 会话解析模块自身是规则的唯一持有者。按形状判定而不是列举文件名：模块换名或拆分后
 * 只要仍叫 `conversation-resolution.ts` 就自动被认作合法持有者，其余服务端源码默认受约束。
 */
const RESOLUTION_MODULE_PATTERN = /(?:^|\/)conversation-resolution\.ts$/

interface ArchitecturePredicate {
  readonly evidence: string
  readonly pattern: RegExp
}

/**
 * 会话集合与实例集合规则的谓词，按写法形状判定而不是按变量命名。
 *
 * 每个集合两条：第一条只认「读或写这个集合」，即集合名后面紧跟方法调用、下标或赋值。放宽到裸
 * `.conversations` 会把「把解析模块投影出来的会话装回快照字段」（`conversations: trimmed.conversations`）
 * 也抓进来，那不是自己查找会话，误报会让豁免清单混进假债务；同时它天然不认领域类型里的
 * 字段声明（`conversations: SandboxConversation[]`），后者是类型定义本身而不是访问。
 *
 * 第二条堵解构旁路：`const { conversations } = scene` 之后的读写不再带 `.conversations` 前缀。
 *
 * 两个集合各写一份而不是合成一条带可选后缀的正则：`.conversations` 那条不会命中
 * `.conversationInstances`（集合名后紧跟的是 `Instances` 而不是访问符），因此实例集合不写就是没有守卫。
 */
const conversationCollectionPredicates: readonly ArchitecturePredicate[] = [
  { evidence: '直接读写会话集合 .conversations', pattern: /\.conversations\s*(?:\.\s*[A-Za-z]|\[|=[^=])/ },
  { evidence: '解构出会话集合绕过解析模块', pattern: /(?:const|let|var)\s*\{[^}]*\bconversations\b[^}]*\}\s*=/ },
  { evidence: '直接读写实例集合 .conversationInstances', pattern: /\.conversationInstances\s*(?:\.\s*[A-Za-z]|\[|=[^=])/ },
  { evidence: '解构出实例集合绕过解析模块', pattern: /(?:const|let|var)\s*\{[^}]*\bconversationInstances\b[^}]*\}\s*=/ },
]

/**
 * 记录域目录模块自身是「谁是全部记录域」这条规则的唯一持有者，同样按形状而不是按文件清单判定。
 */
const SCOPE_DIRECTORY_MODULE_PATTERN = /(?:^|\/)scope-directory\.ts$/

/** 按标识取控制服务的全部写法，外加测试控制端点自己那层包装。 */
const CONTROL_LOOKUP_PATTERN = /\b(?:getControl|resolveControl|requireReadable|requireAiControl|requireUserControl)\s*\(/

/**
 * 入站投递模块自身是「入站消息事件字段怎么组装」这条规则的唯一持有者，同样按形状判定。
 */
const INBOUND_DELIVERY_MODULE_PATTERN = /(?:^|\/)inbound-delivery\.ts$/

/**
 * 入站消息事件组装的形状：事件类型与 raw message 出现在**同一个**对象字面量里。
 *
 * 两者分处不同字面量都不算：读取方向那份 `get_msg` 回执带 raw message 但不带事件类型，
 * notice 与 request 那五份带事件类型但不带 raw message，两类都命不中，因此不需要豁免。
 */
const INBOUND_EVENT_TYPE_PATTERN = /\bpost_type\s*:/
const INBOUND_RAW_MESSAGE_PATTERN = /\braw_message\s*:/

/** 去掉嵌套层，只留本层文本，用于判定两个键是不是同一个对象字面量的自有属性。 */
function stripNestedBraces(body: string): string {
  let depth = 0
  let stripped = ''
  for (const char of body) {
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      continue
    }
    if (depth === 0) stripped += char
  }
  return stripped
}

/** 源码里每个对象字面量的自有属性文本。 */
function objectLiteralOwnLevels(source: string): string[] {
  const levels: string[] = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '{') continue
    levels.push(stripNestedBraces(readBalanced(source, index)))
  }
  return levels
}

/** 从开括号处取出与之配对的那一段文本，用于把「清单交给了谁」这段范围切出来。 */
function readBalanced(source: string, openIndex: number): string {
  const open = source[openIndex]!
  const close = open === '(' ? ')' : open === '[' ? ']' : '}'
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1
    else if (source[index] === close && --depth === 0) return source.slice(openIndex + 1, index)
  }
  return source.slice(openIndex + 1)
}

/**
 * 每处空间清单枚举「把清单交给谁」的那一段文本。
 *
 * 只跟着清单仍在流动的那条路走，因此判定的是写法形状而不是文件里出现过什么：
 * - 清单直接交给某个数组方法的回调时，范围是那对括号；
 * - 清单是 `for…of` 头部的可迭代对象时，范围是紧随其后的循环体。
 *
 * 只匹配成员调用（`X.listSpaces()`），因此清单方法自己的声明不会被当成枚举。清单没有继续
 * 流向任何遍历时（`return this.requireTestSpaces().listSpaces()`）返回空，那只是把清单交给调用方。
 */
function enumerationBodies(source: string): string[] {
  return [...source.matchAll(/\.\s*listSpaces\s*\(\s*\)/g)].flatMap((match) => {
    const after = match.index + match[0].length
    // `?? []`、把清单包起来的右括号与空白都只是转手，清单仍在向后流动。
    const forwarded = /^(?:\s|\)|\?\?|\[|\])*/.exec(source.slice(after))![0]
    const rest = source.slice(after + forwarded.length)
    const chained = /^\.\s*[A-Za-z]+\s*\(/.exec(rest)
    if (chained) return [readBalanced(rest, chained[0].length - 1)]
    return rest.startsWith('{') ? [readBalanced(rest, 0)] : []
  })
}

/**
 * 工具名不得出现在治理路径的判定里。
 *
 * 一个工具的配额档、空间解析方式、幂等与确认令牌标记以及执行体都是工具注册表条目上的字段，因此
 * 治理里没有按名字分支的余地。规则拦住下一个想加特例的人。
 *
 * 谓词按标识符名判定：裸的 `tool`／`toolName`，以及注册表条目自己那个字段 `entry.name`／
 * `definition.name`——治理今天持有的是条目而不是名字，只认裸标识符会漏掉 `entry.name === '…'`
 * 这条最近的加特例路径。刻意不放宽到任意 `X.name`：那个形状在模型证据那一族里有一处合法命中
 * （`name === 'input'` 判定的是模型请求变量的键），会变成误报。
 *
 * 代价是目录项遍历里的 `entry.name` 落进了同一个名字。今天不冲突（那两处用 `endsWith` 与正则，
 * 命不中本规则），真撞上时改循环变量名比加豁免便宜。
 */
const TOOL_NAME_LITERAL_PREDICATES: readonly ArchitecturePredicate[] = [
  { evidence: '工具名与字符串字面量相等或不等比较', pattern: /\b(?:tool|toolName|(?:entry|definition)\s*\.\s*name)\s*(?:={2,3}|!={1,2})\s*'/ },
  { evidence: '字符串字面量与工具名相等或不等比较', pattern: /'[^']*'\s*(?:={2,3}|!={1,2})\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?\b(?:tool|toolName)\b|'[^']*'\s*(?:={2,3}|!={1,2})\s*(?:entry|definition)\s*\.\s*name\b/ },
  { evidence: '在工具名上做前缀判定', pattern: /\b(?:tool|toolName|(?:entry|definition)\s*\.\s*name)\s*\.\s*startsWith\s*\(\s*'/ },
]

/**
 * 抹掉 `typeof` 的操作数，只留运算符自身。
 *
 * `typeof args.tool === 'string'` 比较的是类型名而不是工具名，不抹掉它规则会把每一处参数取值
 * 都当成违规。
 */
function stripTypeofOperands(source: string): string {
  return source.replace(/\btypeof\s+[A-Za-z_$][\w$.]*/g, 'typeof')
}

/**
 * 关系规则模块自身是「群成员角色怎么比较」这条规则的唯一持有者，同样按形状判定。
 */
const RELATIONSHIP_ACTIONS_MODULE_PATTERN = /(?:^|\/)relationship-actions\.ts$/

/**
 * 群成员角色比较不得出现在关系规则模块之外。
 *
 * 谁能踢谁、谁能改群名、谁能审批入群申请，全部是同一族判定；它们此前在用户通道与机器人通道的
 * 入口里各写一遍，修一处群权限要改两处，漏掉一处不会报错。规则拦住下一个想在通道入口里重新写
 * 一遍权限判定的人。
 *
 * 谓词按标识符名收窄，与工具名那条同一个手法：只认 `actor`／`target`／`operator` 这三个名字上的
 * 角色字段与字面量比较。因此两处合法命中天然被避开——场景校验里判断群里有没有群主用的是解构出的
 * 裸 `role` 与 `member.role`，机器人适配器把角色渲染成中文名用的也是 `member.role`。真正会命中的
 * 只剩共用消息能力规则里那道撤回阶梯，它按文件登记为有主豁免。
 */
const GROUP_ROLE_COMPARISON_PREDICATES: readonly ArchitecturePredicate[] = [
  { evidence: '群成员角色与字符串字面量相等或不等比较', pattern: /\b(?:actor|target|operator)\s*\.\s*role\s*(?:={2,3}|!={1,2})\s*'/ },
  { evidence: '字符串字面量与群成员角色相等或不等比较', pattern: /'[^']*'\s*(?:={2,3}|!={1,2})\s*(?:actor|target|operator)\s*\.\s*role\b/ },
]

interface ArchitectureRule {
  readonly name: string
  readonly extensions: readonly string[]
  /** 返回命中的证据描述；空数组表示该文件不违反本规则。 */
  findViolations(file: string, source: string): string[]
}

/**
 * 内置集合与值类型不算协作 module：读自己的集合不是转售。
 */
const OWN_VALUE_TYPE_PATTERN = /^(?:Map|Set|WeakMap|WeakSet|Array|ReadonlyMap|ReadonlySet|ReadonlyArray|Promise|Record|Date|RegExp|Error|Buffer)$/

/**
 * 「哪些私有字段是协作 module 的实例」的两种声明写法：带类型注解的字段（含构造函数参数属性）
 * 与用 `new` 初始化的字段。按声明类型判定而不是按字段名列举，新增一个协作 module 时规则自动覆盖它。
 */
const COLLABORATOR_FIELD_PATTERNS: readonly RegExp[] = [
  /(?:private|protected)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^,)=;\n{]+)/g,
  /(?:private|protected)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)/g,
]

function collaboratorFields(source: string): Set<string> {
  // 同文件里声明的类不算「另一个 module 的类」：读本 module 自己的内部结构不是转售。
  const sameModule = new Set([...source.matchAll(/(?:^|\n)(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)].map(([, name]) => name!))
  const fields = new Set<string>()
  for (const pattern of COLLABORATOR_FIELD_PATTERNS) {
    for (const [, field, declared] of source.matchAll(pattern)) {
      const type = declared!.trim()
      // 数组字面量与数组类型都是自己的集合，不是协作 module。
      if (type.endsWith('[]')) continue
      const head = /^[A-Za-z_$][\w$]*/.exec(type)?.[0]
      if (!head || !/^[A-Z]/.test(head) || OWN_VALUE_TYPE_PATTERN.test(head) || sameModule.has(head)) continue
      fields.add(field!)
    }
  }
  return fields
}

interface ClassMemberBody {
  readonly name: string
  readonly body: string
}

/**
 * 公开成员及其成员体。
 *
 * 按仓库的书写约定切块：类成员缩进两空格，成员体要么在同一行内闭合，要么以行末的 `{` 开头、
 * 由一行 `  }` 收尾。构造函数与私有、受保护、静态成员都不在公开成员表里，因此不参与判定。
 */
function publicMemberBodies(source: string): ClassMemberBody[] {
  const lines = source.split('\n')
  const members: ClassMemberBody[] = []
  for (const [index, line] of lines.entries()) {
    const header = /^ {2}((?:public |private |protected |static |readonly |async |get |set )*)([A-Za-z_$][\w$]*)\s*[(<]/.exec(line)
    if (!header || /\b(?:private|protected|static)\b/.test(header[1]!) || header[2] === 'constructor') continue
    const trimmed = line.trimEnd()
    const openIndex = trimmed.endsWith('{') ? trimmed.length - 1 : trimmed.indexOf('{')
    if (openIndex < 0) continue
    const inline = trimmed.slice(openIndex + 1)
    if (inline.includes('}')) {
      members.push({ name: header[2]!, body: inline.slice(0, inline.lastIndexOf('}')) })
      continue
    }
    const end = lines.indexOf('  }', index + 1)
    if (end < 0) continue
    members.push({ name: header[2]!, body: lines.slice(index + 1, end).join('\n') })
  }
  return members
}

/** 成员体是否恰好只有一次 `this.<字段>.<方法>(…)`；`return this.<字段>`（没有调用）不算。 */
function readSingleDelegation(body: string): { field: string, method: string } | undefined {
  const statement = body.replace(/\/\/[^\n]*/g, '').trim().replace(/;$/, '')
  const head = /^(?:return\s+)?this\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(statement)
  if (!head) return
  const openIndex = head[0].length - 1
  // 调用括号闭合之后不能再有别的语句，否则「两句都在转售」会被当成一句。
  if (statement.slice(openIndex + readBalanced(statement, openIndex).length + 2).trim()) return
  return { field: head[1]!, method: head[2]! }
}

/**
 * 规则制而不是白名单制：谓词跑遍服务端全部源码，新增文件默认受约束。
 */
const rules: readonly ArchitectureRule[] = [
  {
    name: '只有会话解析模块能直接读写会话集合与实例集合',
    extensions: ['.ts'],
    findViolations: (file, source) => {
      if (RESOLUTION_MODULE_PATTERN.test(file)) return []
      return conversationCollectionPredicates
        .filter(({ pattern }) => pattern.test(source))
        .map(({ evidence }) => evidence)
    },
  },
  {
    name: '只有记录域目录能枚举记录域',
    extensions: ['.ts'],
    findViolations: (file, source) => {
      if (SCOPE_DIRECTORY_MODULE_PATTERN.test(file)) return []
      return enumerationBodies(source)
        .filter((body) => CONTROL_LOOKUP_PATTERN.test(body))
        .map(() => '枚举 AI 测试空间后逐个取控制服务')
    },
  },
  {
    /**
     * 一行转售是 shallow 的定义：interface 和 implementation 一样宽，读它的人多学一个名字却
     * 什么也没少知道。九个替证据记录库说话的成员就是这样攒起来的，规则拦住下一个。
     */
    name: '公开成员不得只转售协作 module',
    extensions: ['.ts'],
    findViolations: (_file, source) => {
      const fields = collaboratorFields(source)
      return publicMemberBodies(source).flatMap(({ name, body }) => {
        const delegation = readSingleDelegation(body)
        if (!delegation || !fields.has(delegation.field)) return []
        return [`公开成员 ${name} 只转售 ${delegation.field}.${delegation.method}(…)`]
      })
    },
  },
  {
    /**
     * 三条发送路径原先各自组装一份几乎相同的投递数据，第四份在机器人适配器里。收进投递模块
     * 之后，规则拦住第五份：给投递加一种能力时三条路自动都有，不会出现只加了一条路的情况。
     */
    name: '只有入站投递模块能组装入站消息事件字段',
    extensions: ['.ts'],
    findViolations: (file, source) => {
      if (INBOUND_DELIVERY_MODULE_PATTERN.test(file)) return []
      // 绝大多数文件里没有 raw message，先短路省掉逐个字面量的扫描。
      if (!INBOUND_RAW_MESSAGE_PATTERN.test(source)) return []
      return objectLiteralOwnLevels(source)
        .filter((level) => INBOUND_EVENT_TYPE_PATTERN.test(level) && INBOUND_RAW_MESSAGE_PATTERN.test(level))
        .map(() => '事件类型与 raw message 出现在同一个对象字面量里')
    },
  },
  {
    /**
     * 工具名从治理路径上消失是工具注册表落地的直接结果：分类与标记都是条目上的字段，执行体挂在
     * 同一条条目上。规则跑遍服务端源码、不列文件白名单，也不需要持有者——注册表条目里工具名是
     * 属性值而不是比较，谓词命不中它。
     */
    name: '工具名不得与字符串字面量比较',
    extensions: ['.ts'],
    findViolations: (_file, source) => {
      const normalized = stripTypeofOperands(source)
      return TOOL_NAME_LITERAL_PREDICATES
        .filter(({ pattern }) => pattern.test(normalized))
        .map(({ evidence }) => evidence)
    },
  },
  {
    /**
     * 关系操作的规则收进一个 module 之后，两条操作通道退成 adapter：用户通道直接调它，虚拟
     * OneBot 机器人经自身 OneBot action 落到同一份规则上。规则拦住第二份角色判定——它今天的
     * 失败形态是「从 WebQQ 操作正常、机器人操作却不对」，两条路都通，只是规则不一样。
     */
    name: '群成员角色比较只允许出现在关系规则模块里',
    extensions: ['.ts'],
    findViolations: (file, source) => {
      if (RELATIONSHIP_ACTIONS_MODULE_PATTERN.test(file)) return []
      return GROUP_ROLE_COMPARISON_PREDICATES
        .filter(({ pattern }) => pattern.test(source))
        .map(({ evidence }) => evidence)
    },
  },
]

interface ArchitectureExemption {
  readonly file: string
  readonly rule: string
  /**
   * 成员级豁免：只放行这一个成员。省略表示放行该文件下该规则的全部违规。
   *
   * 「公开成员不得只转售协作 module」这条要的就是成员级粒度：它的两处豁免同在一个文件里，
   * 沿用文件级匹配会让同文件长出第三个转售成员被静默放过。
   */
  readonly member?: string
  /** 必填：为什么当前允许它违反规则。 */
  readonly reason: string
  /** 必填：负责消化这条债务的后续工作。 */
  readonly owner: string
}

/**
 * 已知违规的显式豁免清单，与守卫断言放在同一处，改服务端代码的人立刻看到。
 * 理由与负责人均为必填；豁免不是放行，是有主的债务。
 *
 * 六条规则里四条当前无例外：全部会话查找都已经收进解析模块，全部记录域枚举都已经收进记录域
 * 目录，入站消息事件组装只剩投递模块那一处，工具名在治理路径上已经不存在。转售那条留下两处，
 * 都在同一个文件里，因此按成员登记——同一文件长出第三个转售成员仍要报出。角色比较那条留下一处，
 * 按文件登记：它是共用消息能力规则自己的职责。
 */
const exemptions: readonly ArchitectureExemption[] = [
  {
    file: 'src/message-capabilities.ts',
    rule: '群成员角色比较只允许出现在关系规则模块里',
    reason: '撤回的群角色阶梯是消息能力判据自己的职责（ADR-0078）：它回答「一条消息能不能被撤回」，而关系规则那道阶梯回答「一个成员能对另一个成员做什么」，两者在那条 ADR 里已经判定各自成立、不合并。把它搬进关系规则模块会让消息能力判据反过来依赖关系规则，而它是服务端与客户端共用的纯函数模块。',
    owner: 'ADR-0078 的持有者：这两道阶梯的分工由那条决定钉住；要合并必须先推翻它，而不是在本规则里放行更多文件。',
  },
  {
    file: 'src/control-service.ts',
    rule: '公开成员不得只转售协作 module',
    member: 'getChatLunaStates',
    reason: 'ChatLuna 对话状态库尚未决定归属：它不是证据记录，读取方是工作区状态投影而不是记录页，与本轮收拢的两个记录库不同源。就地把状态库交出去会让工作区投影直接依赖 ChatLuna 事件模型，代价大于这一个键。',
    owner: '后续候选「ChatLuna 状态库的归属」：先判定状态库该由谁持有，再一并收掉这两个成员。',
  },
  {
    file: 'src/control-service.ts',
    rule: '公开成员不得只转售协作 module',
    member: 'recordChatLunaModelRequest',
    reason: '与 getChatLunaStates 同源：写入侧的这一句同样只是替 ChatLuna 状态库转述，两者要在同一次判定里一起处理，单独收掉写入侧会让读写两侧的持有者不一致。',
    owner: '后续候选「ChatLuna 状态库的归属」：先判定状态库该由谁持有，再一并收掉这两个成员。',
  },
]

function listSourceFiles(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(resolve(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path, extensions)
    if (entry.name.endsWith('.d.ts')) return []
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : []
  })
}

function findAllViolations(): string[] {
  return rules.flatMap((rule) => listSourceFiles('src', rule.extensions).flatMap((file) => {
    const source = readFileSync(resolve(file), 'utf8')
    return rule.findViolations(file, source).map((evidence) => `${file} 违反「${rule.name}」：${evidence}`)
  }))
}

function isExempted(violation: string, allowed: readonly ArchitectureExemption[]): boolean {
  return allowed.some(({ file, rule, member }) => (
    violation.startsWith(`${file} 违反「${rule}」：`)
    // 登记了成员就只放行那一个成员；同一文件同一规则下的别的成员仍要报出。
    && (!member || violation.includes(`成员 ${member} `))
  ))
}

describe('服务端架构守卫', () => {
  it('六条规则对服务端源码全量生效，未登记的违规按文件、规则与成员报出', () => {
    expect(findAllViolations().filter((violation) => !isExempted(violation, exemptions))).toEqual([])
  })

  it('规则认得出违规写法，也不误报领域类型里的字段声明', () => {
    const [collectionRule] = rules
    if (!collectionRule) throw new Error('架构规则缺失')

    expect(collectionRule.findViolations('src/x.ts', 'scene.conversations.find(({ id }) => id === target)')).not.toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'this.scene.conversations.push(conversation)')).not.toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'snapshot.conversations.map(({ id }) => id)')).not.toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'this.scene.conversations = remaining')).not.toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'const first = scene.conversations[0]')).not.toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'const { conversations } = scene')).not.toEqual([])
    // 实例集合与会话集合同规则：`.conversations` 那条正则命不中它，必须各自成条。
    expect(collectionRule.findViolations('src/x.ts', 'scene.conversationInstances.filter(({ id }) => id !== target)')).not.toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'snapshot.conversationInstances = []')).not.toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'const { conversationInstances } = scene')).not.toEqual([])
    // 领域类型里的字段声明不是读写，不得误报。
    expect(collectionRule.findViolations('src/x.ts', 'interface Scene { conversations: SandboxConversation[] }')).toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'return { revision: 0, conversations: [], messages: [] }')).toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'return { revision: 0, conversationInstances: [], messages: [] }')).toEqual([])
    // 把解析模块投影出的会话装回快照字段不是自己查找会话，不得误报。
    expect(collectionRule.findViolations('src/x.ts', 'return { ...scene, conversations: projection.conversations, messages }')).toEqual([])
    expect(collectionRule.findViolations('src/x.ts', 'return { ...scene, conversationInstances: projection.conversationInstances }')).toEqual([])
    // 解析模块自身是规则的持有者。
    expect(collectionRule.findViolations('src/conversation-resolution.ts', 'scene.conversations.find(({ id }) => id === target)')).toEqual([])
    expect(collectionRule.findViolations('src/conversation-resolution.ts', 'scene.conversationInstances = rows')).toEqual([])
  })

  it('记录域规则认得出「枚举后逐个取控制服务」，也不误报纯列清单与单空间解析', () => {
    const scopeRule = rules.find(({ name }) => name === '只有记录域目录能枚举记录域')
    if (!scopeRule) throw new Error('记录域架构规则缺失')

    // 链式遍历与 for…of 两种写法，以及测试控制端点自己那层包装，都是同一件事。
    expect(scopeRule.findViolations('src/x.ts', 'testSpaces.listSpaces().map((space) => testSpaces.getControl(space.id))')).not.toEqual([])
    expect(scopeRule.findViolations('src/x.ts', '...(testSpaces?.listSpaces() ?? []).map((space) => testSpaces!.getControl(space.id)\n  .getModelRequestStore().getRecords(query))')).not.toEqual([])
    expect(scopeRule.findViolations('src/x.ts', 'for (const space of testSpaces?.listSpaces() ?? []) {\n  cleared += await testSpaces!.getControl(space.id).getOneBotDebugStore().clear()\n}')).not.toEqual([])
    expect(scopeRule.findViolations('src/x.ts', '...(this.testSpaces?.listSpaces() ?? []).map((space) => this.resolveControl({ spaceId: space.id }, false).getModelRequestStore().getRecords(query))')).not.toEqual([])
    // 纯粹把清单列给用户或外部测试控制器看：只取清单，不取控制服务。
    expect(scopeRule.findViolations('src/x.ts', "registerListener('test-spaces', () => testSpaces.listSpaces()\n  .map((space) => ({ ...space, snapshot: trimSnapshotMessages(space.snapshot, 10) })), { authority: 4 })\nconst spaceControl = testSpaces.getControl(input.spaceId)")).toEqual([])
    expect(scopeRule.findViolations('src/x.ts', "if (tool === 'list_test_spaces') return this.requireTestSpaces().listSpaces()\nreturn this.requireTestSpaces().getControl(args.spaceId)")).toEqual([])
    // 带显式空间标识的单空间解析不枚举，不该命中。
    expect(scopeRule.findViolations('src/x.ts', 'const space = testSpaces.getSpace(input.spaceId)\nconst spaceControl = testSpaces.getControl(space.id)')).toEqual([])
    // 清单方法自身的声明不是枚举，不得把方法体当成使用点。
    expect(scopeRule.findViolations('src/x.ts', 'listSpaces(): SandboxTestSpaceSummary[] {\n  return [...this.spaces.values()].map((space) => this.getControl(space.id))\n}')).toEqual([])
    // 记录域目录自身是规则的持有者。
    expect(scopeRule.findViolations('src/scope-directory.ts', 'testSpaces.listSpaces().map(({ id }) => testSpaces.getControl(id))')).toEqual([])
  })

  it('转售规则认得出一行委托，也不误报读自己集合、裸字段返回、自由函数与记录库自身', () => {
    const resellRule = rules.find(({ name }) => name === '公开成员不得只转售协作 module')
    if (!resellRule) throw new Error('转售架构规则缺失')

    /** 三个字段各代表一类：协作 module、内置集合、数组字面量。 */
    const thing = (...members: string[]) => [
      "import { SandboxModelRequestStore } from './model-request'",
      '',
      'export class Thing {',
      '  private records: SandboxModelRequestStore',
      '  private rows = new Map<string, string>()',
      '  private names: SandboxName[] = []',
      '',
      ...members,
      '}',
      '',
    ].join('\n')

    // 带返回值、不带返回值与 async 三种形态都是同一件事。
    expect(resellRule.findViolations('src/x.ts', thing(
      '  getRecords(input: Query): Promise<Page> {',
      '    return this.records.getRecords(input)',
      '  }',
    ))).toEqual(['公开成员 getRecords 只转售 records.getRecords(…)'])
    expect(resellRule.findViolations('src/x.ts', thing(
      '  trackUpdate(task: Promise<void>): void {',
      '    this.records.trackUpdate(task)',
      '  }',
    ))).toEqual(['公开成员 trackUpdate 只转售 records.trackUpdate(…)'])
    expect(resellRule.findViolations('src/x.ts', thing(
      '  async clearRecords(): Promise<number> {',
      '    return this.records.clear()',
      '  }',
    ))).toEqual(['公开成员 clearRecords 只转售 records.clear(…)'])
    // 参数跨行不改变「只有一句」这个事实。
    expect(resellRule.findViolations('src/x.ts', thing(
      '  requireRecord(recordId: string, includeLargeValues: boolean) {',
      '    return this.records.requireRecord(',
      '      recordId,',
      '      includeLargeValues,',
      '    )',
      '  }',
    ))).toEqual(['公开成员 requireRecord 只转售 records.requireRecord(…)'])

    // 读自己的集合不是转售。
    expect(resellRule.findViolations('src/x.ts', thing(
      '  listRows(): string[] {',
      '    return this.rows.get(key)',
      '  }',
      '',
      '  listNames(): SandboxName[] {',
      '    return this.names.map(toName)',
      '  }',
    ))).toEqual([])
    // 把记录库整个交出去正是本规则想要的结果，没有调用就不是转售。
    expect(resellRule.findViolations('src/x.ts', thing(
      '  getModelRequestStore(): SandboxModelRequestStore {',
      '    return this.records',
      '  }',
    ))).toEqual([])
    // 只有一句但调用的是自由函数：这一句是本 module 自己的判断。
    expect(resellRule.findViolations('src/x.ts', thing(
      '  describe(input: Query): string {',
      '    return describeQuery(this.records, input)',
      '  }',
    ))).toEqual([])
    // 私有成员不在公开成员表里。
    expect(resellRule.findViolations('src/x.ts', thing(
      '  private forward(input: Query) {',
      '    return this.records.getRecords(input)',
      '  }',
    ))).toEqual([])
    // 两句都在转售时不能被当成一句放过。
    expect(resellRule.findViolations('src/x.ts', thing(
      '  clearBoth(): void {',
      '    this.records.clear()',
      '    this.records.trackUpdate(task)',
      '  }',
    ))).toEqual([])

    // 同 module 内声明的类不是「另一个 module 的类」：读本 module 自己的内部结构不是转售。
    expect(resellRule.findViolations('src/record-store.ts', [
      'export class ScopeRowIndex {',
      '  summary(): Summary {',
      '    return { recordCount: 0 }',
      '  }',
      '}',
      '',
      'export class InMemoryRecordRows {',
      '  private index = new ScopeRowIndex()',
      '',
      '  async summarize(): Promise<Summary> {',
      '    return this.index.summary()',
      '  }',
      '}',
      '',
    ].join('\n'))).toEqual([])

    // 记录库自身：读取要先等落盘再问持久化，是多句；落盘等待的那一句委托是私有的。
    expect(resellRule.findViolations('src/onebot-debug.ts', [
      "import { SerialWriteQueue } from './record-store'",
      '',
      'export class SandboxOneBotDebugStore {',
      '  private persistence: SandboxOneBotDebugPersistence',
      '  private readonly writes: SerialWriteQueue',
      '',
      '  waitForPersistence(): Promise<void> {',
      '    return this.settle()',
      '  }',
      '',
      '  async getRecord(recordId: string): Promise<Record | undefined> {',
      '    await this.settle()',
      '    return this.persistence.find(recordId)',
      '  }',
      '',
      '  private settle(): Promise<void> {',
      '    return this.writes.settle()',
      '  }',
      '}',
      '',
    ].join('\n'))).toEqual([])
  })

  it('入站消息事件规则认得出同一字面量里的事件类型与 raw message，也不误报读取方向与通知那两族', () => {
    const rule = rules.find(({ name }) => name === '只有入站投递模块能组装入站消息事件字段')
    if (!rule) throw new Error('入站投递架构规则缺失')

    // 沙盒挂在会话上的原始载荷就是这个形状，嵌一层也照样认得出。
    expect(rule.findViolations('src/x.ts', [
      'Object.assign(session, {',
      '  onebot: {',
      "    post_type: 'message',",
      "    message_type: 'private',",
      '    message: segments,',
      '    raw_message: rawMessage,',
      '  },',
      '})',
    ].join('\n'))).toEqual(['事件类型与 raw message 出现在同一个对象字面量里'])

    // 读取方向那份带 raw message 但不带事件类型，是 get_msg 的回执而不是一次入站事件。
    expect(rule.findViolations('src/x.ts', [
      'return {',
      "  message_type: conversation?.type === 'group' ? 'group' : 'private',",
      '  message: onebotMessage,',
      '  raw_message: toOneBotRawMessage(onebotMessage),',
      '}',
    ].join('\n'))).toEqual([])

    // notice 与 request 那五份带事件类型但不带 raw message，组装留在控制服务是本轮的决定。
    expect(rule.findViolations('src/x.ts', [
      'Object.assign(session, {',
      '  onebot: {',
      "    post_type: 'notice',",
      '    notice_type: noticeType,',
      '    ...noticeData,',
      '  },',
      '})',
    ].join('\n'))).toEqual([])

    // 两者分处不同字面量不是一次组装，不得合报。
    expect(rule.findViolations('src/x.ts', [
      "const head = { post_type: 'message' }",
      'const body = { raw_message: rawMessage }',
    ].join('\n'))).toEqual([])

    // 投递模块自身是规则的持有者。
    expect(rule.findViolations('src/inbound-delivery.ts', "{ post_type: 'message', raw_message: rawMessage }")).toEqual([])
  })

  it('工具名规则认得出相等、不等与前缀三种写法，也不误报属性值、类型判定与模型证据那处名字比较', () => {
    const rule = rules.find(({ name }) => name === '工具名不得与字符串字面量比较')
    if (!rule) throw new Error('工具名架构规则缺失')

    // 分派链、配额分类与那句九项否定条件原先的三种写法。
    expect(rule.findViolations('src/x.ts', "if (tool === 'get_server_info') return this.serverInfo()")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "this.resolveControl(args, tool !== 'get_scene_snapshot' && tool !== 'export_scene')")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "const category = tool.startsWith('wait_for_') ? 'wait' : 'read'")).not.toEqual([])
    // 换个持有工具名的表达式一样算，规则不靠「裸标识符」这个形状。
    expect(rule.findViolations('src/x.ts', "if (args.tool === 'reset_scene') return true")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if ('clear_scene' === confirmation.tool) return true")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if (toolName === 'upload_media') return 'upload'")).not.toEqual([])
    // 治理今天持有的是注册表条目而不是名字，`entry.name` 是最近的一条加特例路径。
    expect(rule.findViolations('src/x.ts', "if (entry.name === 'upload_media') return 'upload'")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if (entry.name.startsWith('wait_for_')) return 'wait'")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if ('reset_scene' === definition.name) return true")).not.toEqual([])

    // 目录项遍历里的 entry.name 落进同一个名字，但那两处用 endsWith 与正则，命不中本规则。
    expect(rule.findViolations('src/presets/repository.ts', "if (!entry.name.endsWith('.yml') || !entry.isFile()) continue")).toEqual([])
    expect(rule.findViolations('src/media-storage.ts', "if (!/^[a-f0-9]{32}$/.test(entry.name)) continue")).toEqual([])
    // 条目名字当值用不是比较。
    expect(rule.findViolations('src/x.ts', 'new Map(REGISTERED.map((entry) => [entry.name, entry]))')).toEqual([])
    expect(rule.findViolations('src/x.ts', 'toolName: definition.name,')).toEqual([])

    // 注册表条目里工具名是属性值而不是比较，谓词命不中它——这正是本规则零豁免的原因。
    expect(rule.findViolations('src/mcp/tool-registry.ts', "{ name: 'get_server_info', scope: 'read', quota: 'read' }")).toEqual([])
    expect(rule.findViolations('src/mcp/tool-registry.ts', "tool: { type: 'string', enum: ['reset_scene', 'clear_scene'] }")).toEqual([])
    // 类型判定比较的是类型名而不是工具名。
    expect(rule.findViolations('src/x.ts', "tool: typeof args.tool === 'string' ? args.tool : undefined")).toEqual([])
    // 两个标识符之间的比较不是按名字开特例。
    expect(rule.findViolations('src/x.ts', 'if (confirmation.tool !== entry.name) return false')).toEqual([])
    expect(rule.findViolations('src/x.ts', 'if (input.tool && record.tool !== input.tool) return false')).toEqual([])
    // 模型证据那一族里这处名字比较是合法的：宽松形状会把它当成违规，因此规则按标识符名判定。
    expect(rule.findViolations('src/model-evidence/request.ts', "if (name === 'input') return isRecord(value)")).toEqual([])
  })

  /**
   * 谓词按标识符名收窄，因此正反两侧都要钉：三个名字上的相等、不等与字面量在左三种写法必须
   * 命中，而场景校验、按角色挑收件机器人、角色名渲染这几处合法用法必须不命中。
   */
  it('角色比较规则认得出三个标识符名上的两种写法，也不误报场景校验与角色名渲染', () => {
    const rule = rules.find(({ name }) => name === '群成员角色比较只允许出现在关系规则模块里')
    if (!rule) throw new Error('角色比较架构规则缺失')

    // 三个标识符名各代表一类：行为者、目标、审批申请的操作者；相等与不等两种写法都算。
    expect(rule.findViolations('src/x.ts', "if (actor.role === 'member') throw new SandboxDomainError('只有群主或管理员可以踢出成员')")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if (target.role === 'owner') throw new SandboxDomainError('不能修改群主权限')")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if (actor.role !== 'owner') throw new SandboxDomainError('只有群主可以设置管理员')")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if (operator.role !== 'owner' && operator.role !== 'admin') throw new SandboxDomainError('只有群主或管理员可以处理入群申请')")).not.toEqual([])
    // 字面量写在左边一样算。
    expect(rule.findViolations('src/x.ts', "if ('owner' === target.role) return 'target-is-owner'")).not.toEqual([])
    expect(rule.findViolations('src/x.ts', "if ('member' !== actor.role) return undefined")).not.toEqual([])

    // 场景校验里判断群里有没有群主：用的是解构出的裸 role 与 member.role，天然不命中。
    expect(rule.findViolations('src/x.ts', "if (group.members.filter(({ role }) => role === 'owner').length !== 1) throw new SandboxDomainError('群组必须且只能有一个群主')")).toEqual([])
    expect(rule.findViolations('src/x.ts', "if (member.role === 'owner') continue")).toEqual([])
    // 按角色挑收件机器人同样是解构出的裸 role。
    expect(rule.findViolations('src/x.ts', "group.members.flatMap(({ participantId, role }) => role === 'owner' || role === 'admin' ? [participantId] : [])")).toEqual([])
    // 机器人适配器把角色渲染成中文名：这是呈现而不是权限判定，用的也是 member.role。
    expect(rule.findViolations('src/bot.ts', "const roleName = member.role === 'owner' ? '群主' : member.role === 'admin' ? '管理员' : '成员'")).toEqual([])
    // 角色当值用不是比较。
    expect(rule.findViolations('src/x.ts', "target.role = enabled ? 'admin' : 'member'")).toEqual([])
    expect(rule.findViolations('src/x.ts', 'roles: [{ id: member.role }]')).toEqual([])
    // 两个标识符之间的比较不是按角色开特例。
    expect(rule.findViolations('src/x.ts', 'if (actor.role === target.role) return undefined')).toEqual([])

    // 关系规则模块自身是规则的持有者。
    expect(rule.findViolations('src/relationship-actions.ts', "return actor.role === 'member' ? 'requires-group-authority' : undefined")).toEqual([])
  })

  /**
   * 会话解析模块与领域类型一样被客户端一同引用。它一旦 import 'koishi'，整个 Koishi 运行时
   * 就会被打进前端产物（实测 +460 KB）。这类回归不会报错，只会让产物默默变大，因此需要守卫。
   */
  it('被客户端一同引用的领域模块不依赖 Koishi 运行时', () => {
    for (const file of ['src/conversation-resolution.ts', 'src/types.ts']) {
      const source = readFileSync(resolve(file), 'utf8')
      expect([...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!).filter((specifier) => (
        specifier === 'koishi' || specifier.startsWith('koishi/') || specifier.startsWith('@koishijs/')
      )), file).toEqual([])
    }
  })

  it('未登记成员的豁免按文件与规则成对匹配，移除后违规重新暴露', () => {
    const violation = 'src/x.ts 违反「只有会话解析模块能直接读写会话集合与实例集合」：直接读写会话集合 .conversations'
    const exemption: ArchitectureExemption = {
      file: 'src/x.ts',
      rule: '只有会话解析模块能直接读写会话集合与实例集合',
      reason: '合成条目，仅用于自测豁免匹配。',
      owner: '无',
    }

    expect(isExempted(violation, [exemption])).toBe(true)
    // 同一条规则在另一个文件上不得被放行。
    expect(isExempted(violation.replace('src/x.ts', 'src/y.ts'), [exemption])).toBe(false)
    expect(isExempted(violation, [])).toBe(false)
  })

  /**
   * 转售规则的两处豁免同在一个文件里。文件级匹配会让同文件长出第三个转售成员被静默放过，
   * 因此登记了成员的豁免必须只放行那一个成员。
   */
  it('登记了成员的豁免只放行那一个成员，同文件同规则的别的成员仍然报出', () => {
    const rule = '公开成员不得只转售协作 module'
    const exempted = `src/control-service.ts 违反「${rule}」：公开成员 getChatLunaStates 只转售 chatLunaState.getStates(…)`
    const another = `src/control-service.ts 违反「${rule}」：公开成员 getMediaLabel 只转售 mediaStorage.describe(…)`
    const exemption: ArchitectureExemption = {
      file: 'src/control-service.ts',
      rule,
      member: 'getChatLunaStates',
      reason: '合成条目，仅用于自测成员级豁免匹配。',
      owner: '无',
    }

    expect(isExempted(exempted, [exemption])).toBe(true)
    expect(isExempted(another, [exemption])).toBe(false)
    // 成员名相同但文件不同时同样不得放行。
    expect(isExempted(exempted.replace('src/control-service.ts', 'src/y.ts'), [exemption])).toBe(false)
  })

  it('每条豁免都写明理由与负责消化它的后续工作', () => {
    for (const exemption of exemptions) {
      expect(exemption.reason.trim(), `${exemption.file} / ${exemption.rule} 缺少理由`).not.toBe('')
      expect(exemption.owner.trim(), `${exemption.file} / ${exemption.rule} 缺少负责人`).not.toBe('')
      // 占位文字不算理由。
      expect(exemption.reason, `${exemption.file} / ${exemption.rule} 的理由是占位文字`).not.toMatch(/^(?:TODO|待补|暂时|无)/)
      expect(exemption.owner, `${exemption.file} / ${exemption.rule} 的负责人是占位文字`).not.toMatch(/^(?:TODO|待补|暂时|无)$/)
    }
  })

  /**
   * 逐条移除豁免后对应文件必须重新报错：证明规则真的在逐文件起作用，
   * 而不是被豁免清单整体旁路，也顺带保证清单里没有已经消化掉的陈旧条目。
   * 成员级豁免同样如此：移除它只应暴露它自己那一个成员。
   */
  it('移除任一豁免后对应文件重新报错', () => {
    const violations = findAllViolations()
    for (const removed of exemptions) {
      const remaining = exemptions.filter((exemption) => exemption !== removed)
      const exposed = violations.filter((violation) => !isExempted(violation, remaining))
      expect(exposed.length, `移除 ${removed.file} / ${removed.rule} 后规则没有报错`).toBeGreaterThan(0)
      expect([...new Set(exposed.map((violation) => violation.split('：')[0]!))], `${removed.file} / ${removed.rule}`)
        .toEqual([`${removed.file} 违反「${removed.rule}」`])
      if (removed.member) {
        expect(exposed, `移除 ${removed.file} / ${removed.member} 后暴露的不只是它自己`)
          .toEqual([expect.stringContaining(`成员 ${removed.member} `)])
      }
    }
  })
})
