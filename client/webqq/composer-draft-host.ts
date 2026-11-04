// 移植自源插件：草稿模型与宿主读写协议保持不变，只把 Vue 响应式换成通知回调。
import {
  createEmptyComposerDraft,
  deleteComposerBackward,
  detectMentionTrigger,
  filterMentionCandidates,
  insertComposerMention,
  isComposerDraftEmpty,
  normalizeComposerTokens,
  replaceComposerTextRange,
  serializeComposerDraft,
  type ComposerDraft,
  type ComposerDraftToken,
  type MentionCandidate,
} from './composer-draft'

/**
 * 草稿与 contenteditable 之间的双向转换、光标读写、输入法状态与提及候选菜单。
 *
 * 纯 token 计算早就下沉了（`composer-draft.ts`）；真正会出问题的是「怎么把它和 contenteditable
 * 对上」：从子节点遍历回读出草稿、把草稿渲染成节点、把光标放到第几个 token 的第几个偏移、
 * 输入法未上屏时不许读回、input 事件早于 Selection 更新时要等一拍。这几块此前全留在发送控件里，
 * 一条行为断言都没有，而它们的失效形态都是静默的——光标跳到开头、中文输入法上屏后前一个字符
 * 消失、退格删掉半个提及——不报错，只能靠人在界面上敲出来。
 *
 * 候选菜单与草稿同处一个模块：每次输入都要重算菜单、方向键要被路由给菜单、选中候选项又要写回
 * 草稿并移动光标，拆开会让两者之间的 interface 宽到没有意义。
 *
 * 判定进这个模块，带副作用与有时序的宿主操作按最小结构接口注入（ADR 0075）：不注入 DOM 类型，
 * 视图负责把 Text 节点、提及芯片与 Selection 映射成下面这几个朴素结构。
 */

/** 编辑器一个子节点的结构读数。视图从 DOM 映射出来，映射本身是机械动作。 */
export type ComposerHostNodeReading =
  | { readonly kind: 'text', readonly text: string }
  | { readonly kind: 'mention', readonly id: string, readonly name: string }
  /** 浏览器在 contenteditable 里换行时插入的 `<br>`。 */
  | { readonly kind: 'line-break' }
  /** 浏览器编辑时套上的容器元素，正文在它的子节点里。 */
  | { readonly kind: 'container', readonly children: readonly ComposerHostNodeReading[] }

/** 要渲染进编辑器的节点。与 token 一一对应，视图按它造 Text 节点与提及芯片。 */
export type ComposerHostNodePlan =
  | { readonly kind: 'text', readonly text: string }
  | { readonly kind: 'mention', readonly id: string, readonly name: string }

/** 光标在宿主里的落点读数。 */
export type ComposerHostCaretReading =
  /** 落在编辑器元素本身上，偏移是子节点序号。 */
  | { readonly kind: 'editor', readonly childOffset: number }
  /** 落在第 `childIndex` 个子节点里，含落进提及芯片内部的文字。 */
  | { readonly kind: 'child', readonly childIndex: number, readonly offset: number }

/** 光标要写到哪里。 */
export type ComposerHostCaretTarget =
  | { readonly kind: 'child', readonly childIndex: number, readonly offset: number }
  /** 目标 token 不存在：落到编辑器末尾。 */
  | { readonly kind: 'editor-end' }

export interface ComposerDraftCaret {
  readonly tokenIndex: number
  readonly offset: number
}

/**
 * 空文本 token 的光标锚点。
 *
 * 提及芯片不可编辑，两侧必须各有一个真实文本节点，用户才点得出光标；空文本节点在宿主里没有
 * 可点面积，因此填一个零宽字符。回读时它不算正文，由 `normalizeComposerTokens` 去掉。
 */
export const COMPOSER_CARET_ANCHOR = '​'

/** 从子节点结构读数回读出草稿 token。容器被摊平，换行成为正文里的换行字符。 */
export function readComposerDraftTokens(
  readings: readonly ComposerHostNodeReading[],
): ComposerDraftToken[] {
  const tokens: ComposerDraftToken[] = []
  const walk = (reading: ComposerHostNodeReading) => {
    if (reading.kind === 'text') {
      tokens.push({ type: 'text', text: reading.text })
      return
    }
    if (reading.kind === 'mention') {
      tokens.push({ type: 'mention', id: reading.id, name: reading.name })
      return
    }
    if (reading.kind === 'line-break') {
      tokens.push({ type: 'text', text: '\n' })
      return
    }
    reading.children.forEach(walk)
  }
  readings.forEach(walk)
  return normalizeComposerTokens(tokens)
}

/** 把草稿渲染成节点计划。 */
export function planComposerHostNodes(
  tokens: readonly ComposerDraftToken[],
): ComposerHostNodePlan[] {
  const plan = tokens.map((token): ComposerHostNodePlan => token.type === 'text'
    ? { kind: 'text', text: token.text || COMPOSER_CARET_ANCHOR }
    : { kind: 'mention', id: token.id, name: token.name })
  // 浏览器在空 contenteditable 里常插入 `<br>`；至少留一个文本节点，光标与 `:empty` 判定才成立。
  return plan.length ? plan : [{ kind: 'text', text: '' }]
}

/**
 * 把光标夹到一个可落脚的位置。
 *
 * 提及 token 上没有可落脚的偏移（芯片不可编辑），统一挪到后一个文本 token 起点；
 * `normalizeComposerTokens` 保证每个提及后面都有一个文本 token。
 */
function clampDraftCaret(
  tokens: readonly ComposerDraftToken[],
  tokenIndex: number,
  offset: number,
): ComposerDraftCaret {
  const lastIndex = Math.max(0, tokens.length - 1)
  const index = Math.min(Math.max(tokenIndex, 0), lastIndex)
  const token = tokens[index]
  if (token?.type === 'text') {
    return { tokenIndex: index, offset: Math.min(Math.max(offset, 0), token.text.length) }
  }
  return { tokenIndex: Math.min(index + 1, lastIndex), offset: 0 }
}

/**
 * 读回光标落在第几个 token 的第几个偏移。
 *
 * 落在编辑器元素上有两种含义：下一个子节点是文本时归到它的起点；是提及芯片时停在**前一个**
 * 文本 token 末尾——用户此时看到的光标就贴在芯片左侧，接着退格删的应当是这个提及。
 *
 * 子节点序号按「一个 token 一个节点」对应。浏览器换行插入的 `<br>` 会在回读时并进相邻文本
 * token，节点数从此多于 token 数，落在换行之后的光标因此夹到最后一个 token 上——这是治理前
 * 就有的口径，本轮逐字保留，不在这里顺手改判。
 */
export function resolveComposerCaretFromReading(
  tokens: readonly ComposerDraftToken[],
  reading: ComposerHostCaretReading,
): ComposerDraftCaret {
  if (reading.kind === 'editor') {
    const next = tokens[reading.childOffset]
    if (!next) return clampDraftCaret(tokens, tokens.length - 1, Number.MAX_SAFE_INTEGER)
    if (next.type === 'mention') {
      return clampDraftCaret(tokens, reading.childOffset - 1, Number.MAX_SAFE_INTEGER)
    }
    return clampDraftCaret(tokens, reading.childOffset, 0)
  }
  const token = tokens[reading.childIndex]
  return clampDraftCaret(tokens, reading.childIndex, token?.type === 'text' ? reading.offset : 0)
}

/**
 * 把「第几个 token 的第几个偏移」换成宿主的落点。
 *
 * 偏移只收下界不收上界：空文本 token 在宿主里是一个零宽字符节点，长度是 1 而不是 0，
 * 真实节点长度只有宿主知道，上限由视图夹紧。
 */
export function resolveComposerCaretTarget(
  tokens: readonly ComposerDraftToken[],
  tokenIndex: number,
  offset: number,
): ComposerHostCaretTarget {
  const token = tokens[tokenIndex]
  if (!token) return { kind: 'editor-end' }
  if (token.type === 'text') {
    return { kind: 'child', childIndex: tokenIndex, offset: Math.max(offset, 0) }
  }
  // 提及芯片不可编辑：光标写到它后面那个文本节点起点。
  return { kind: 'child', childIndex: tokenIndex + 1, offset: 0 }
}

/**
 * 把正文偏移换成宿主那个文本节点里的偏移。
 *
 * 零宽锚点是渲染空文本 token 时补进去的占位符，回读时不算正文。用户在空草稿里打过字之后节点里
 * 仍留着它（那次输入不重渲染），草稿 token 因此比真实节点短一位；直接把正文偏移当节点偏移写回去
 * 会让光标停在最后一个字之前，表现为右键「回复」之后接着打的字插到草稿中间。
 *
 * 上界也在这里收：真实节点文本只有视图读得到，走到末尾就停下。
 */
export function resolveComposerHostTextOffset(text: string, offset: number): number {
  let remaining = Math.max(offset, 0)
  let index = 0
  while (index < text.length && remaining > 0) {
    if (text[index] !== COMPOSER_CARET_ANCHOR) remaining -= 1
    index += 1
  }
  // 落点后面紧跟锚点时也要跨过去：停在锚点前会让下一个字插到这个不算正文的字符之前。
  while (index < text.length && text[index] === COMPOSER_CARET_ANCHOR) index += 1
  return index
}

/** 候选菜单开着时它盯住的那个 `@片段`：在第几个 token、从第几位开始、已经打进去了什么。 */
export interface ComposerMentionMenuState {
  readonly tokenIndex: number
  readonly start: number
  readonly query: string
}

/**
 * 菜单该不该开。
 *
 * 四条关闭条件各有各的理由：一个候选都没有时（私聊）开个空菜单只是挡住输入区；组字期间宿主里
 * 是未上屏的拼音，据它过滤等于用拼音去搜人；光标不在文本 token 上时没有可检测的片段；
 * 片段里一出现空白就说明用户已经在写正文而不是在挑人。
 */
export function resolveComposerMentionMenu(input: {
  readonly tokens: readonly ComposerDraftToken[]
  readonly tokenIndex: number
  readonly offset: number
  readonly composing: boolean
  readonly hasCandidates: boolean
}): ComposerMentionMenuState | undefined {
  if (!input.hasCandidates || input.composing) return
  const token = input.tokens[input.tokenIndex]
  if (token?.type !== 'text') return
  const trigger = detectMentionTrigger(token.text, input.offset)
  if (!trigger) return
  return { tokenIndex: input.tokenIndex, start: trigger.start, query: trigger.query }
}

export type ComposerKeyAction =
  /** 不消费，交给宿主的默认行为：普通字符、换行、移动光标、删一个字符。 */
  | { readonly kind: 'none' }
  /** 发送中或没有会话：吞掉这次按键，输入区整体不接受编辑。 */
  | { readonly kind: 'blocked' }
  | { readonly kind: 'move-candidate', readonly delta: 1 | -1 }
  | { readonly kind: 'select-candidate' }
  | { readonly kind: 'close-menu' }
  /** 光标正贴在提及右边，这次退格删掉整块提及。 */
  | { readonly kind: 'delete-mention' }
  /** 交回调用方去发送。发送编排不反过来问菜单开没开。 */
  | { readonly kind: 'submit' }

/**
 * 光标是不是正贴在一个提及的右边。
 *
 * 只认「当前是文本 token 且偏移为 0，前一个 token 是提及」这一种形状——那正是用户看到光标
 * 紧贴芯片右侧的位置。`normalizeComposerTokens` 保证提及永远不在第 0 位，因此前一个 token 一定
 * 存在；读回光标也永远不会停在提及 token 上（会被挪到它后面那个文本 token 的起点），
 * 所以「光标在提及内部」这种情形已经被归一成这同一种形状。
 *
 * **偏移 1 不算边界。** 选中候选后提及右边会自动补一个不换行空格，光标停在空格之后（偏移 1）。
 * 那个位置上的退格只删掉那个空格，提及留着——这是治理前的行为，本轮保留。
 */
export function isComposerMentionBoundary(
  tokens: readonly ComposerDraftToken[],
  tokenIndex: number,
  offset: number,
): boolean {
  if (offset !== 0) return false
  if (tokens[tokenIndex]?.type !== 'text') return false
  return tokens[tokenIndex - 1]?.type === 'mention'
}

/**
 * 退格落在提及边界上：整块删掉那个提及，光标停在它原来的位置。
 *
 * token 算术复用 `deleteComposerBackward`，光标不复用它给的落点：它把光标放到合并后那个文本
 * token 的**末尾**，提及后面还有正文时那是行尾而不是提及原来的位置，表现为「删掉一个提及，
 * 光标却跳到了行尾」。删掉提及之后前后两段文本会合并成一个 token，提及原来的位置就是
 * 前一段文本的长度。
 */
export function deleteComposerMentionAtBoundary(
  tokens: readonly ComposerDraftToken[],
  tokenIndex: number,
): ComposerDraft {
  const before = tokens[tokenIndex - 2]
  return {
    tokens: deleteComposerBackward(tokens, tokenIndex, 0).tokens,
    tokenIndex: Math.max(0, tokenIndex - 2),
    offset: before?.type === 'text' ? before.text.length : 0,
  }
}

/**
 * 这一次按键是什么意思。
 *
 * 「Enter 到底是发送还是选中候选」此前是组件里的一个内联条件，散在模板事件绑定与两个处理函数
 * 之间；现在由这一个函数回答，调用方只按返回值决定要不要 `preventDefault`。
 *
 * 退格只在提及边界上被消费，让「整块删掉提及」这条规则由本模块说了算，两个引擎口径一致；
 * 其余位置的退格照旧交给宿主，删一个字符就是删一个字符。菜单开着时不可能同时落在提及边界上
 * （菜单要求光标前面有 `@片段`，边界要求偏移为 0），两个分支互不相交。
 */
export function routeComposerKey(input: {
  readonly key: string
  readonly shiftKey: boolean
  readonly disabled: boolean
  readonly composing: boolean
  readonly menuOpen: boolean
  readonly mentionBoundary: boolean
}): ComposerKeyAction {
  if (input.disabled) return { kind: 'blocked' }

  if (input.menuOpen) {
    if (input.key === 'ArrowDown') return { kind: 'move-candidate', delta: 1 }
    if (input.key === 'ArrowUp') return { kind: 'move-candidate', delta: -1 }
    if (input.key === 'Enter' || input.key === 'Tab') return { kind: 'select-candidate' }
    if (input.key === 'Escape') return { kind: 'close-menu' }
  }

  // 组字期间的 Enter 是上屏确认；shift+Enter 是换行。两者都不是发送。
  if (input.key === 'Enter' && !input.shiftKey && !input.composing) return { kind: 'submit' }
  // 组字期间的退格由输入法处理未上屏的拼音，不该动草稿。
  if (input.key === 'Backspace' && input.mentionBoundary && !input.composing) return { kind: 'delete-mention' }
  return { kind: 'none' }
}

/** 宿主操作。带副作用、有时序，全部按最小结构接口注入。 */

/** 草稿宿主的最小响应式：值写入即通知订阅方，派生值按读取时现算。React 侧以订阅触发重渲染。 */
interface Cell<T> { value: T }
function createCells(notify: () => void) {
  const ref = <T>(initial: T): Cell<T> => {
    let current = initial
    return {
      get value() { return current },
      set value(next: T) {
        if (Object.is(next, current)) return
        current = next
        notify()
      },
    }
  }
  const computed = <T>(read: () => T): { readonly value: T } => ({ get value() { return read() } })
  return { ref, computed }
}

export interface ComposerDraftHostAdapter {
  /** 回读编辑器子节点；宿主还没挂上时返回 undefined。 */
  readNodes(): readonly ComposerHostNodeReading[] | undefined
  /** 按计划整体替换编辑器子节点。 */
  renderNodes(plan: readonly ComposerHostNodePlan[]): void
  /** 读光标落点；光标不在编辑器里时返回 undefined。 */
  readCaret(): ComposerHostCaretReading | undefined
  /** 把光标写到目标落点。 */
  writeCaret(target: ComposerHostCaretTarget): void
  /** 等下一拍。contenteditable 的 input 事件有时早于 Selection 更新。 */
  nextTick(): Promise<void>
  /** 聚焦输入控件。 */
  focus(): void
  /**
   * 当前可提及的候选。
   *
   * 候选的来源与「谁能被提及」由上层模型决定；宿主只管菜单什么时候开、按已输入的片段怎么过滤。
   */
  readMentionCandidates(): readonly MentionCandidate[]
}

export function createComposerDraftHost(adapter: ComposerDraftHostAdapter, notify: () => void = () => {}) {
  const { ref, computed } = createCells(notify)
  const draft = ref<ComposerDraft>(createEmptyComposerDraft())
  /** 输入法组字中。此前是模板上两个内联赋值，四处判定各读一次。 */
  const composing = ref(false)
  /**
   * 占位文案与发送按钮的可用性都看这一项。
   *
   * 组字期间草稿仍是空的（不读回），但宿主里已经有未上屏的拼音；此时若按「草稿为空」显示占位
   * 文案，它会和拼音叠在一起。因此组字中一律不算空。
   */
  const isEmpty = computed(() => !composing.value && isComposerDraftEmpty(draft.value.tokens))
  const mentionMenu = ref<ComposerMentionMenuState | undefined>(undefined)
  /**
   * 高亮项的原始序号与夹紧后的序号分开。
   *
   * 候选表会随上层模型变短（有人退群、切换会话），夹紧写成 computed 而不是一个 watch：
   * 高亮项因此永远指向一个真实存在的候选，不需要靠某次副作用去修正它。
   */
  const rawMentionIndex = ref(0)
  /** 菜单开着的条件里带上「候选列表非空」：私聊没有可提及的人，菜单一次都不该出现。 */
  const mentionMenuOpen = computed(() => !!mentionMenu.value && adapter.readMentionCandidates().length > 0)
  const mentionCandidates = computed(() => mentionMenu.value
    ? filterMentionCandidates(adapter.readMentionCandidates(), mentionMenu.value.query)
    : [])
  const mentionMenuIndex = computed(() => Math.min(
    Math.max(rawMentionIndex.value, 0),
    Math.max(0, mentionCandidates.value.length - 1),
  ))
  /** 程序化替换节点期间不读回：宿主若把这次替换报成 input，读回会拿到半份内容。 */
  let suppressRead = false

  function closeMentionMenu() {
    mentionMenu.value = undefined
    rawMentionIndex.value = 0
  }

  function updateMentionMenu() {
    const current = draft.value
    const next = resolveComposerMentionMenu({
      tokens: current.tokens,
      tokenIndex: current.tokenIndex,
      offset: current.offset,
      composing: composing.value,
      hasCandidates: adapter.readMentionCandidates().length > 0,
    })
    if (!next) {
      closeMentionMenu()
      return
    }
    mentionMenu.value = next
    rawMentionIndex.value = 0
  }

  function render() {
    suppressRead = true
    adapter.renderNodes(planComposerHostNodes(draft.value.tokens))
    suppressRead = false
  }

  function apply(next: ComposerDraft, options: { focus?: boolean } = {}) {
    draft.value = {
      tokens: normalizeComposerTokens(next.tokens),
      tokenIndex: next.tokenIndex,
      offset: next.offset,
    }
    render()
    if (options.focus === false) return
    // 等节点替换生效后再聚焦写光标；同一拍里写会落在已经被替换掉的旧节点上。
    void adapter.nextTick().then(focus)
  }

  /**
   * 把焦点交回输入框，光标落到草稿记着的位置。
   *
   * 光标必须显式写。右键菜单打开期间焦点先落在菜单容器上，浏览器为 contenteditable 记住的选区
   * 到这时已经作废，只 focus 会让光标落在正文最前面，接着输入的字插到草稿前面。
   */
  function focus() {
    adapter.focus()
    const current = draft.value
    adapter.writeCaret(resolveComposerCaretTarget(current.tokens, current.tokenIndex, current.offset))
  }

  /** 清空草稿与候选菜单。切换会话与切换发送者时用，不抢焦点——用户可能正在别处操作。 */
  function reset() {
    apply(createEmptyComposerDraft(), { focus: false })
    closeMentionMenu()
  }

  function readCaret(tokens: readonly ComposerDraftToken[]): ComposerDraftCaret | undefined {
    const reading = adapter.readCaret()
    if (!reading) return
    return resolveComposerCaretFromReading(tokens, reading)
  }

  /** 按宿主当前 Selection 对齐草稿光标。指针与方向键之后用。 */
  function syncCaretFromHost() {
    const caret = readCaret(draft.value.tokens)
    if (!caret) return
    draft.value = { ...draft.value, ...caret }
  }

  /**
   * 宿主报出一次输入。
   *
   * 两条时序都在这里：组字期间一个字都不读回；读回前先等一拍，否则读到的是旧光标，
   * 表现为「单独输入 @ 之后候选菜单不弹」。
   */
  async function handleInput() {
    if (suppressRead) return
    // 组字期间菜单仍要关掉：留着它会拿未上屏的拼音去过滤候选。
    if (composing.value) {
      closeMentionMenu()
      return
    }
    await adapter.nextTick()
    const readings = adapter.readNodes()
    if (!readings) return
    const tokens = readComposerDraftTokens(readings)
    const caret = readCaret(tokens)
    draft.value = {
      tokens,
      tokenIndex: caret?.tokenIndex ?? draft.value.tokenIndex,
      offset: caret?.offset ?? draft.value.offset,
    }
    updateMentionMenu()
  }

  function startComposition() {
    composing.value = true
  }

  /** 上屏。此刻宿主里的正文才是最终结果，立刻读回一次。 */
  async function endComposition() {
    composing.value = false
    await handleInput()
  }

  /** 从别处（消息右键「提及某人」）插入一个提及。 */
  function insertMention(mention: { id: string, name: string }) {
    syncCaretFromHost()
    const current = draft.value
    const token = current.tokens[current.tokenIndex]
    const offset = token?.type === 'text' ? current.offset : 0
    apply(insertComposerMention(current.tokens, current.tokenIndex, offset, mention))
    closeMentionMenu()
  }

  /** 选中一个候选：`@片段` 整段换成提及，光标越过自动补入的分隔空格停在提及之后。 */
  function selectMentionCandidate(candidate: MentionCandidate) {
    const menu = mentionMenu.value
    if (!menu) return
    const token = draft.value.tokens[menu.tokenIndex]
    const end = token?.type === 'text' ? draft.value.offset : menu.start
    apply(replaceComposerTextRange(
      draft.value.tokens,
      menu.tokenIndex,
      menu.start,
      Math.max(menu.start, end),
      { id: candidate.id, name: candidate.name },
    ))
    closeMentionMenu()
  }

  function moveMentionSelection(delta: number) {
    const total = mentionCandidates.value.length
    if (!total) return
    rawMentionIndex.value = (mentionMenuIndex.value + delta + total) % total
  }

  /**
   * 路由一次按键，并把菜单相关的动作就地执行掉。
   *
   * 返回的动作同时回答了「这次按键有没有被候选菜单消费」：调用方只在 `none` 时放任宿主默认行为，
   * 只在 `submit` 时走发送。发送编排因此不必反过来问菜单开没开。
   */
  function routeKey(input: { key: string, shiftKey: boolean, disabled: boolean }): ComposerKeyAction {
    const current = draft.value
    const action = routeComposerKey({
      key: input.key,
      shiftKey: input.shiftKey,
      disabled: input.disabled,
      composing: composing.value,
      menuOpen: mentionMenuOpen.value,
      mentionBoundary: isComposerMentionBoundary(current.tokens, current.tokenIndex, current.offset),
    })
    if (action.kind === 'move-candidate') moveMentionSelection(action.delta)
    if (action.kind === 'close-menu') closeMentionMenu()
    if (action.kind === 'select-candidate') {
      const candidate = mentionCandidates.value[mentionMenuIndex.value]
      if (candidate) selectMentionCandidate(candidate)
    }
    if (action.kind === 'delete-mention') {
      apply(deleteComposerMentionAtBoundary(current.tokens, current.tokenIndex))
    }
    return action
  }

  function serialize() {
    return serializeComposerDraft(draft.value.tokens)
  }

  return {
    draft,
    composing,
    isEmpty,
    mentionMenuOpen,
    mentionCandidates,
    mentionMenuIndex,
    render,
    apply,
    reset,
    syncCaretFromHost,
    handleInput,
    startComposition,
    endComposition,
    insertMention,
    selectMentionCandidate,
    closeMentionMenu,
    setMentionSelection: (index: number) => {
      rawMentionIndex.value = index
    },
    routeKey,
    serialize,
    focus,
  }
}

export type ComposerDraftHost = ReturnType<typeof createComposerDraftHost>
