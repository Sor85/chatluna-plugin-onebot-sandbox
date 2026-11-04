// ego lite 被控空间边缘跑马灯的 Web 移植。
// 片元着色器逐字取自 ego lite resources.pak（条目 58803，原生 OverlayOuter/InnerGlowRenderer 共用），
// 效果为：贴窗缘描边环经 14 次随机旋转采样模糊成雾带，accent 色纵向 alpha ramp 随 uScrollOffset
// 循环滚动——光带因此沿边缘持续移动。参数预设在 C++ overlay_params.h 内无法提取，
// 按 ego 实机截屏标定：边缘近满饱和、向内扩散 ≈120-160 CSS px、四角因双边叠加自然更亮。
const GLOW_FRAGMENT = `#version 100
precision mediump float;

uniform vec2 uResolution;

uniform float uStroke;
uniform float uBlur;
uniform float uRadius;
uniform float uFade;
uniform vec4 uAccent;
uniform float uScrollOffset;

float hash21(vec2 p) {
  vec2 q = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  q = q + dot(q, q + 19.19);
  return fract(q.x * q.y);
}

float ringDist(vec2 p_in) {
  float r = max(uRadius, 0.0);
  vec2 half_res = uResolution * 0.5;
  vec2 p = abs(p_in - half_res) - (half_res - vec2(r));
  float outside = length(max(p, vec2(0.0)));
  float inside = min(max(p.x, p.y), 0.0);
  return -(outside + inside - r);
}

vec4 rampColor(float t_in) {
  float t = fract(t_in);
  vec4 a = vec4(uAccent.rgb, 0.8);
  vec4 m = vec4(uAccent.rgb, 0.0);
  vec4 lo = mix(a, m, smoothstep(0.0, 0.5, t));
  vec4 hi = mix(m, a, smoothstep(0.5, 1.0, t));
  return t < 0.5 ? lo : hi;
}

float hardStroke(vec2 p) {
  float d = ringDist(p);
  float halfS = max(uStroke * 0.5, 1.0);
  return smoothstep(halfS, 0.0, abs(d));
}

float sampleStroke(vec2 fragcoord, float blur, float cs, float sn, vec2 off) {
  vec2 rot = vec2(off.x * cs - off.y * sn, off.x * sn + off.y * cs);
  return hardStroke(fragcoord + rot * blur);
}

void main() {
  vec2 fragcoord = gl_FragCoord.xy;
  float blur = max(uBlur, 0.5);
  float theta = hash21(fragcoord) * 6.2831853;
  float cs = cos(theta);
  float sn = sin(theta);

  float sum = hardStroke(fragcoord) * 1.00000000;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(0.5253, -0.1547)) * 0.54895195;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(-0.4254, -0.3611)) * 0.53648497;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(0.0840, 0.6276)) * 0.44848703;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(-0.6783, 0.2515)) * 0.35109927;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(-0.2049, -0.8231)) * 0.23717542;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(0.7975, 0.4521)) * 0.18622469;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(-0.8654, -0.1832)) * 0.20909663;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(0.1521, -0.5736)) * 0.49445322;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(0.5612, 0.2138)) * 0.48611417;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(-0.1834, 0.3015)) * 0.77952102;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(-0.4421, 0.7531)) * 0.21757231;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(0.8123, -0.4986)) * 0.16253425;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(-0.7211, -0.6173)) * 0.16495394;
  sum += sampleStroke(fragcoord, blur, cs, sn, vec2(0.2412, -0.9012)) * 0.17540148;

  float tile = max(uResolution.y, 1.0);
  float scroll = mod(uScrollOffset, tile);
  if (scroll < 0.0) {
    scroll += tile;
  }
  float t = (fragcoord.y + scroll) / tile;
  vec4 ramp = rampColor(t);
  float alpha = (sum / 6.22071317) * clamp(uFade, 0.0, 1.0) * ramp.a;
  gl_FragColor = vec4(ramp.rgb * alpha, alpha);
}
`

const VERTEX = `attribute vec2 a_Position;
void main() { gl_Position = vec4(a_Position, 0.0, 1.0); }
`

// 内外两层光晕（CSS px 单位，运行时乘 dpr）。向内扩散 ≈ stroke/2 + blur；相位错半圈保证任意时刻
// 整圈都有光带，反向滚动制造流动纵深 [推断]。
const GLOW_PRESETS = [
  { stroke: 160, blur: 115, radius: 14, fade: 1, accent: [0.27, 0.42, 0.85, 1], scrollSpeed: 1 / 7, scrollPhase: 0 },
  { stroke: 76, blur: 185, radius: 14, fade: 1, accent: [0.27, 0.42, 0.85, 1], scrollSpeed: -1 / 9, scrollPhase: 0.5 },
  // 这是原本的数据（按 ego 实机截屏标定的初版参数，后应需求加宽扩散后弃用，保留备查）：
  // { stroke: 110, blur: 80, radius: 14, fade: 1, accent: [0.27, 0.42, 0.85, 1], scrollSpeed: 1 / 7, scrollPhase: 0 },
  // { stroke: 50, blur: 130, radius: 14, fade: 0.85, accent: [0.27, 0.42, 0.85, 1], scrollSpeed: -1 / 9, scrollPhase: 0.5 },
]

interface GlProgram {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[chatluna-sandbox] overlay shader 编译失败：', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createProgram(gl: WebGLRenderingContext, fragment: string): GlProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment)
  if (!vs || !fs) return null
  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'a_Position')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[chatluna-sandbox] overlay shader 链接失败：', gl.getProgramInfoLog(program))
    return null
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)
    if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name)
  }
  return { program, uniforms }
}

// 挂载 ego 式跑马灯特效。返回卸载函数；WebGL 不可用时返回 null（此时仅保留 CSS scrim 与点阵背景）。
export function mountAgentOverlayEffect(canvas: HTMLCanvasElement): (() => void) | null {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false })
  if (!gl) return null
  const glow = createProgram(gl, GLOW_FRAGMENT)
  if (!glow) return null

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.enable(gl.BLEND)
  // 着色器输出 premultiplied alpha，按 source-over 叠加（与 ego OverlayCompositor 一致）。
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let frame = 0
  let disposed = false
  const start = performance.now()

  function resize() {
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
  }

  function setFloat(name: string, value: number) {
    const loc = glow!.uniforms[name]
    if (loc) gl!.uniform1f(loc, value)
  }

  function render(now: number) {
    if (disposed) return
    resize()
    const width = canvas.width
    const height = canvas.height
    const time = (now - start) / 1000
    gl!.viewport(0, 0, width, height)
    gl!.clearColor(0, 0, 0, 0)
    gl!.clear(gl!.COLOR_BUFFER_BIT)

    gl!.useProgram(glow!.program)
    for (const preset of GLOW_PRESETS) {
      gl!.uniform2f(glow!.uniforms.uResolution!, width, height)
      setFloat('uStroke', preset.stroke * dpr)
      setFloat('uBlur', preset.blur * dpr)
      setFloat('uRadius', preset.radius * dpr)
      setFloat('uFade', preset.fade)
      const accentLoc = glow!.uniforms.uAccent
      if (accentLoc) gl!.uniform4f(accentLoc, preset.accent[0], preset.accent[1], preset.accent[2], preset.accent[3])
      setFloat('uScrollOffset', (time * preset.scrollSpeed + preset.scrollPhase) * height)
      gl!.drawArrays(gl!.TRIANGLES, 0, 3)
    }

    if (!reducedMotion) frame = requestAnimationFrame(render)
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (reducedMotion) render(performance.now())
  })
  observer?.observe(canvas)
  // 首帧同步绘制：后台标签页的 rAF 可能被冻结，保证至少渲染出静态画面。
  render(performance.now())

  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    observer?.disconnect()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
