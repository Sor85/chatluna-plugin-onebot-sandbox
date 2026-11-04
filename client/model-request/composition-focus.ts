/**
 * 请求组成图的焦点窗口：轨道横轴只铺展开中的那几条请求。
 *
 * 会话轨道的横轴是整段会话，一条请求分到的那一格因此随请求数变窄；而账本里被展开的那几条
 * 正是用户此刻在读的。焦点窗口把「展开了哪几条」这份已有状态同时用作轨道的横轴范围：只展开
 * 一条时它铺满整条轨道，读法与单请求（分析）视图完全一致——请求内部的分段本来就按字符占比
 * 铺满自己那一格，把那一格拉到全宽得到的正是分析视图里的那条轨道。
 *
 * 展开多条时窗口取它们的并集跨度，夹在中间的请求会一起露出来。窗口是时间轴上的一段而不是
 * 被展开项的拼贴：拼贴要把不相邻的几格接到一起，横轴从此不再是时间，「耗时」布局与请求边界线
 * 都会失去意义。全部折叠与全部展开都退回整段会话。
 *
 * 这里只做几何：窗口由时间槽与展开清单求得，投影是一次纯线性映射，动画的起始变换只是两个窗口
 * 的比值。三者都不碰 DOM，因此可以逐项断言（ADR-0075），动画本身留在视图里执行。
 */

/** 一条请求在整段会话轴上占的那一格，与视图里的时间分段同形。 */
export interface CompositionFocusSlot {
  readonly id: string
  readonly left: number
  readonly width: number
}

/** 轨道当前铺开的那一段会话轴，单位是占整段会话的百分比。 */
export interface CompositionFocusWindow {
  readonly left: number
  readonly width: number
}

/** 轨道上的一段几何，未投影时按整段会话计，投影后按窗口计。 */
export interface CompositionFocusSpan {
  readonly left: number
  readonly width: number
}

/**
 * 窗口切换时把新几何先摆回旧窗口的那一次变换。
 *
 * 偏移的单位是轨道自身宽度的百分比而不是像素：轨道宽度还随手动缩放倍率变化，写成像素就要在
 * 每次切换时量一遍视图口，而量到的值在动画期间又可能过时。
 */
export interface CompositionFocusFlip {
  readonly scaleX: number
  readonly translateX: number
}

/** 焦点窗口切换的动画时长与缓动，与工作台其他布局动画同一套口径。 */
export const COMPOSITION_FOCUS_TRANSITION_MS = 320
export const COMPOSITION_FOCUS_EASE = 'out(3)'

/** 没有窗口时等价的那一个窗口：整段会话。求变换时用它，省掉两处缺省分支。 */
const FULL_WINDOW: CompositionFocusWindow = { left: 0, width: 100 }

/**
 * 窗口宽度的下限。进行中的请求在「耗时」布局下没有跨度（时间槽宽度为 0），只展开这一条时
 * 并集是一个零宽区间，倍率会除零。这种情况没有可放大的跨度，退回整段会话，而不是把倍率夹到
 * 一个巨大的有限值去放大一格空白。
 */
const FOCUS_WINDOW_MIN_WIDTH = 0.01

/** 投影容差：并集端点由浮点求得，恰好贴着窗口边缘的分段与边界线不该被判成窗口外。 */
const FOCUS_EDGE_TOLERANCE = 0.001

/**
 * 端点噪声：小于它的重叠一律当作「贴着边缘但没有落进窗口」。
 *
 * 窗口端点与分段端点求法不同却指向同一个刻度——窗口端点取时间槽的左右缘，分段端点由
 * 「格左 + 格宽 × 格内占比」连乘求得，而格内占比本身是逐项累加出来的。两串运算在百分比量级
 * （0~100）上会差出几个 ULP，也就是 1e-15 上下。判据必须留出这份余量：邻格的末段正好结束在
 * 窗口起点上时，差出的那一丝会被投影倍率放成一条正宽度，再被视图的像素级最小宽度撑成一枚短桩。
 *
 * 余量取到 1e-12，与真实的细分段之间仍有六个数量级：一条请求的组成项最细也是「一个字符占
 * 整份请求体」，在最窄的时间槽里仍有 1e-7 量级的宽度。
 */
const FOCUS_EDGE_NOISE = 1e-12

/** 视觉上等于没动的变换。自动刷新会把同一个窗口重新求一遍值，不该为此重起一段动画。 */
const FOCUS_FLIP_MIN_SCALE_DELTA = 0.001
const FOCUS_FLIP_MIN_TRANSLATE = 0.01

/**
 * 展开清单对应的窗口；缺省表示轨道铺整段会话。
 *
 * 全部展开与全部折叠都返回缺省：并集此时等于整条轴，给出一个「恰好等于全宽」的窗口只会让
 * 调用方多走一遍投影，还会让切换时凭空多出一次没有位移的动画。
 */
export function resolveCompositionFocusWindow(
  slots: readonly CompositionFocusSlot[],
  focusedIds: ReadonlySet<string>,
): CompositionFocusWindow | undefined {
  if (!slots.length || !focusedIds.size) return undefined
  if (slots.every(({ id }) => focusedIds.has(id))) return undefined
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  for (const slot of slots) {
    if (!focusedIds.has(slot.id)) continue
    left = Math.min(left, slot.left)
    right = Math.max(right, slot.left + slot.width)
  }
  // 展开清单可能还带着上一份轨迹的请求标识，一条都对不上时按没有窗口处理。
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined
  const clampedLeft = Math.min(Math.max(left, 0), 100)
  const clampedRight = Math.min(Math.max(right, 0), 100)
  const width = clampedRight - clampedLeft
  if (width < FOCUS_WINDOW_MIN_WIDTH) return undefined
  return { left: clampedLeft, width }
}

/**
 * 窗口里该画哪几条请求的分段；缺省表示轨道铺整段会话，不筛。
 *
 * 「落在窗口里」不能只按几何判。进行中的请求在时间轴上是一格零宽的槽（它只标出起点），而零宽槽
 * 恰好贴在窗口端点上时，几何无从分辨它是窗口自己的边界还是隔壁那一条被顶到了边上：展开的那条
 * 请求若正在进行，它定义的正是窗口端点，那一枚标记必须画；而一条没展开的进行中请求被前一格顶到
 * 同一个刻度上时，画出来就成了「只打开一条请求却露出别人的分段」。身份是唯一分得开的判据。
 *
 * 因此规则是：展开的请求恒画；没展开的请求要在窗口内真的占到一段宽度才画——夹在并集中间的那几条
 * 满足这一条，只是端点贴着窗口边缘的邻格不满足。
 */
export function resolveCompositionFocusRequests(
  slots: readonly CompositionFocusSlot[],
  window: CompositionFocusWindow | undefined,
  focusedIds: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (!window) return undefined
  const visible = new Set<string>()
  for (const slot of slots) {
    if (focusedIds.has(slot.id) || overlapsFocusWindow(window, slot)) visible.add(slot.id)
  }
  return visible
}

/**
 * 把一条分段投影到窗口里；整段落在窗口外时返回缺省，由调用方跳过它。
 *
 * 越出窗口的分段必须真的不渲染。轨道视图口是横向滚动容器，落在窗口右侧的绝对定位分段会撑出
 * 滚动范围，用户能把「铺满整条轨道」的窗口滚开；跨过窗口边缘的分段夹进窗口内，视觉与裁切一致，
 * 但不给滚动范围留任何余量。
 *
 * 不重新兜最小宽度：最小宽度的口径定在未缩放的占比上（请求组成 module 的那一个常量），焦点里
 * 再兜一次会让细分段随倍率变厚，读出来的占比比真实值大。零宽分段照样保留——进行中的请求靠它
 * 在轨道上标出起点，它属于哪条请求由上面那份清单先筛过一遍。
 */
export function projectCompositionFocusSpan(
  window: CompositionFocusWindow | undefined,
  span: CompositionFocusSpan,
): CompositionFocusSpan | undefined {
  if (!window) return span
  // 邻格贴着窗口边缘的残留不画：视图给分段兜了一个像素级最小宽度，留下来会在窗口边缘变成一枚
  // 短桩，看起来像这条请求多出一档内容——只展开一条请求时，前一条请求的末段（工具声明是请求体
  // 的末尾一档）就正好结束在窗口起点上。
  //
  // 判据必须落在未投影的坐标上。投影会把端点差乘上 100/窗口宽：一条请求只占整段会话的百分之
  // 零点几时倍率上百，端点求法不同带来的那 1e-15 会被放成一条能画出来的正宽度，「夹完只剩零宽」
  // 这种按等号判的写法因此拦不住它。
  if (span.width > 0 && !overlapsFocusWindow(window, span)) return undefined
  const scale = 100 / window.width
  const left = (span.left - window.left) * scale
  const right = left + span.width * scale
  if (right < -FOCUS_EDGE_TOLERANCE || left > 100 + FOCUS_EDGE_TOLERANCE) return undefined
  const clampedLeft = Math.min(Math.max(left, 0), 100)
  const clampedRight = Math.min(Math.max(right, 0), 100)
  return { left: clampedLeft, width: clampedRight - clampedLeft }
}

/** 一条有宽度的区间有没有真的落进窗口，端点差留出一份浮点噪声的余量。 */
function overlapsFocusWindow(window: CompositionFocusWindow, span: CompositionFocusSpan): boolean {
  const left = Math.max(span.left, window.left)
  const right = Math.min(span.left + span.width, window.left + window.width)
  return right - left > FOCUS_EDGE_NOISE
}

/** 请求边界线的投影：落在窗口外的那几根不画，留在窗口内的按窗口坐标给出。 */
export function projectCompositionFocusBoundary(
  window: CompositionFocusWindow | undefined,
  position: number,
): number | undefined {
  const projected = window ? (position - window.left) * (100 / window.width) : position
  if (projected < -FOCUS_EDGE_TOLERANCE || projected > 100 + FOCUS_EDGE_TOLERANCE) return undefined
  return Math.min(Math.max(projected, 0), 100)
}

/**
 * 窗口切换时的起始变换（FLIP）。
 *
 * 几何在切换那一拍就已经是新窗口的，动画只负责把新几何先摆回旧窗口的位置与大小再回到原位。
 * 反过来做——先动画几何、再落位——要在每一帧按新占比重排上千条绝对定位分段，而这一路自始至终
 * 只有一个合成层变换。代价是切换瞬间被移出窗口的分段直接消失，不会跟着缩回去：它们已经不在
 * 新几何里。正在跑的那一段动画终点恒为原位，因此中途换目标不会把轨道留在错位状态。
 */
export function resolveCompositionFocusFlip(
  previous: CompositionFocusWindow | undefined,
  next: CompositionFocusWindow | undefined,
): CompositionFocusFlip | undefined {
  const from = previous ?? FULL_WINDOW
  const to = next ?? FULL_WINDOW
  const scaleX = to.width / from.width
  const translateX = (to.left - from.left) * (100 / from.width)
  const still = Math.abs(scaleX - 1) < FOCUS_FLIP_MIN_SCALE_DELTA
    && Math.abs(translateX) < FOCUS_FLIP_MIN_TRANSLATE
  return still ? undefined : { scaleX, translateX }
}
