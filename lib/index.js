// dsh-update-assistant — host plugin.
// Checks desktop-app / plugin updates and performs a *process-level* update:
// a one-shot scheduled task takes over (outside the Host process tree), kills
// the app, runs the cached installer silently, verifies the version and
// relaunches. This deliberately does not rely on the shell's 10s graceful
// shutdown, which any plugin keeping a ref'd timer can blow through.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-update-assistant'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = dirname(HERE)
const HELPER = join(HERE, 'helper.ps1')
const TASK_NAME = 'DSHUpdateAssistant'
const LOG_TAIL = 60

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

/** Install directory, derived from the running executable (Electron-as-Node host). */
function installDir() {
  const candidates = [dirname(process.env.DSH_DESKTOP_EXE ?? process.execPath)]
  if (process.env.LOCALAPPDATA !== undefined) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'))
  for (const dir of candidates) {
    if (existsSync(join(dir, 'DeepSeek Harness.exe')) || existsSync(join(dir, 'resources', 'app-update.yml'))) return dir
  }
  return candidates[0]
}

function installedVersion() {
  try {
    const out = powershell("(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' } | Select-Object -First 1).DisplayVersion")
    const version = out.trim()
    return version.length > 0 ? version : undefined
  } catch { return undefined }
}

function updaterRoot() {
  return join(process.env.LOCALAPPDATA ?? '', '@deepseek-aidsh-desktop-updater')
}

function pendingUpdate() {
  const info = readJson(join(updaterRoot(), 'pending', 'update-info.json'))
  if (info === undefined || typeof info.fileName !== 'string') return undefined
  const versionMatch = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-win-/.exec(info.fileName)
  return { version: versionMatch?.[1], fileName: info.fileName, path: join(updaterRoot(), 'pending', info.fileName), sha512: info.sha512 }
}

/** Latest version advertised by the generic update feed configured in app-update.yml. */
async function feedLatestVersion() {
  const yml = join(installDir(), 'resources', 'app-update.yml')
  let text
  try { text = readFileSync(yml, 'utf8') } catch { return undefined }
  const url = /^url:\s*(\S+)/m.exec(text)?.[1]
  if (url === undefined) return undefined
  const channel = /^channel:\s*(\S+)/m.exec(text)?.[1]
  const files = channel === undefined ? ['latest.yml'] : [`${channel}.yml`, 'latest.yml']
  for (const file of files) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/${file}`, { signal: AbortSignal.timeout(6000) })
      if (!res.ok) continue
      const version = /^version:\s*(\S+)/m.exec(await res.text())?.[1]
      if (version !== undefined) return { version, source: `${url}${file}` }
    } catch { /* try next */ }
  }
  return undefined
}

function profileDir() {
  if (process.env.DSH_PROFILE_DIR !== undefined) return process.env.DSH_PROFILE_DIR
  if (process.env.DSH_HOME !== undefined) return join(process.env.DSH_HOME, 'profiles', 'desktop')
  // The desktop shell spawns the Host with cwd = profile directory.
  const cwd = process.cwd()
  return readJson(join(cwd, 'package.json'))?.dsh?.profile === undefined ? undefined : cwd
}

function listPlugins() {
  const dir = profileDir()
  if (dir === undefined) return []
  const deps = readJson(join(dir, 'package.json'))?.dependencies ?? {}
  return Object.entries(deps).map(([depName, spec]) => ({
    name: depName,
    spec,
    installed: readJson(join(dir, 'node_modules', depName, 'package.json'))?.version,
  }))
}

async function npmLatest(depName) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${depName}/latest`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return undefined
    return (await res.json()).version
  } catch { return undefined }
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = String(b).replace(/^v/, '').split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

function activeWork(ctx) {
  const agents = ctx.get?.('agents')
  const jobs = ctx.get?.('jobs')
  if (agents === undefined || jobs === undefined) return { known: false, agents: [], jobs: [] }
  const live = agents.list()
  const busyAgents = live.filter((agent) => agent.status === 'running' || (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0)
  const busyJobs = [undefined, ...live].flatMap((agent) => jobs.list(agent?.id) ?? []).filter((job) => job.status === 'running' || job.status === 'stopping')
  return { known: true, agents: busyAgents.map((agent) => agent.id), jobs: busyJobs.map((job) => job.id) }
}

function activeWorkText(ctx, action) {
  const work = activeWork(ctx)
  if (!work.known || (work.agents.length === 0 && work.jobs.length === 0)) return undefined
  return `有活跃任务，拒绝直接${action}：agents=[${work.agents.join(', ')}] jobs=[${work.jobs.join(', ')}]。\n先结束这些任务，或明确传 confirm=true 强制继续（会丢失正在进行的回答）。`
}

/**
 * Writes the helper config + launcher and registers a one-shot scheduled task.
 * Task Scheduler starts the helper in its own process tree, so killing the app
 * (the caller's ancestor) cannot take the helper down with it.
 */
function scheduleHelper(mode, delaySeconds, target) {
  const runtime = join(PLUGIN_ROOT, 'runtime')
  mkdirSync(runtime, { recursive: true })
  const logFile = join(runtime, 'update.log')
  const configFile = join(runtime, 'config.json')
  writeFileSync(configFile, JSON.stringify({
    mode,
    installDir: installDir(),
    exe: join(installDir(), 'DeepSeek Harness.exe'),
    installer: target?.installer,
    targetVersion: target?.version,
    logFile,
  }, null, 2))
  const launcher = join(runtime, 'launch.cmd')
  writeFileSync(launcher, `@echo off\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${HELPER}" -ConfigPath "${configFile}"\r\n`)
  const at = new Date(Date.now() + delaySeconds * 1000)
  at.setSeconds(0, 0)
  at.setMinutes(at.getMinutes() + 1)
  // Near midnight (or just after rounding) the computed slot can already be
  // past; add a minute until it is in the future.
  while (at.getTime() <= Date.now() + 30_000) at.setMinutes(at.getMinutes() + 1)
  // schtasks /st /sd parsing is locale-dependent; Register-ScheduledTask takes
  // a DateTime, so registration goes through a tiny PowerShell shim instead.
  const register = join(runtime, 'register-task.ps1')
  writeFileSync(register, [
    'param([Parameter(Mandatory=$true)][string]$Launcher,[Parameter(Mandatory=$true)][string]$At)',
    "$ErrorActionPreference = 'Stop'",
    "cmd /c exit 0 | Out-Null",
    "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c \"' + $Launcher + '\"')",
    "$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse($At, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeLocal))",
    "Register-ScheduledTask -TaskName 'DSHUpdateAssistant' -Action $action -Trigger $trigger -Force | Out-Null",
  ].join('\r\n'))
  const local = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
  ].join('-') + 'T' + [String(at.getHours()).padStart(2, '0'), String(at.getMinutes()).padStart(2, '0'), '00'].join(':')
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', register, '-Launcher', launcher, '-At', local])
  return { at, launcher, logFile, configFile }
}

function logTail(file) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-LOG_TAIL).join('\n')
  } catch { return '' }
}

function appendLog(file, message) {
  try {
    const line = new Date().toISOString() + '  ' + message + '\r\n'
    writeFileSync(file, (existsSync(file) ? readFileSync(file, 'utf8') : '') + line)
  } catch { }
}

function result(ok, text) {
  return { ok, text }
}

// The installed spec is forwarded to `cmd /c dsh.cmd plugin add <spec>`, so it
// must not be able to inject cmd metacharacters. Accept npm-style
// `name`, `@scope/name`, optionally with `@version`/`@range`.
const SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[0-9A-Za-z][0-9A-Za-z.+_-]*)?$/

function isSafeSpec(spec) {
  return typeof spec === 'string' && spec.length > 0 && spec.length <= 200 && SPEC_PATTERN.test(spec)
}

function isSafeVersion(version) {
  return typeof version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,60}$/.test(version)
}

function sha512Base64(file) {
  try { return createHash('sha512').update(readFileSync(file)).digest('base64') } catch { return undefined }
}

/** scheduleHelper, but a scheduler failure becomes a tool-level error message. */
function trySchedule(mode, delaySeconds, target) {
  try {
    return { scheduled: scheduleHelper(mode, delaySeconds, target) }
  } catch (error) {
    return { error: String(error?.stderr ?? error?.message ?? error).trim().slice(0, 300) }
  }
}

// Known "ref'd timer keeps the Host alive" defects in third-party bundles.
// The shell demands a graceful exit within 10s; any ref'd timer after
// shutdown() makes that impossible, so these rules patch the installed copies
// in place. They are content-based and idempotent: a rule only fires when the
// unpatched form is present exactly once.
const UNREF_TARGETS = [
  {
    id: 'femo-plugin',
    file: ['node_modules', 'femo-plugin', 'hostAdapter', 'dshAdapter', 'lib', 'main.js'],
    rules: [
      { match: (t) => t === 'return new Promise((r) => setTimeout(r, ms));', fix: (l) => l.replace('setTimeout(r, ms)', 'setTimeout(r, ms).unref?.()') },
      { match: (t) => t === '}, 200);', fix: (l) => l.replace('}, 200);', '}, 200).unref?.();') },
      { match: (t) => t === '}, HEARTBEAT_INTERVAL);', fix: (l) => l.replace('}, HEARTBEAT_INTERVAL);', '}, HEARTBEAT_INTERVAL).unref?.();') },
      { match: (t) => t === '}, 1e3);', fix: (l) => l.replace('}, 1e3);', '}, 1e3).unref?.();') },
    ],
  },
  {
    id: 'meow-memory',
    file: ['node_modules', 'meow-memory', 'lib', 'index.js'],
    rules: [
      { match: (t) => t.startsWith('guideTimer = setTimeout(') && !t.includes('unref'), fix: (l) => l + ' guideTimer.unref?.();' },
      { match: (t) => t.startsWith('routeTimer = setTimeout(') && !t.includes('unref'), fix: (l) => l + ' routeTimer.unref?.();' },
      { match: (t) => t.startsWith('commandTimer = setTimeout(') && !t.includes('unref'), fix: (l) => l + ' commandTimer.unref?.();' },
      { match: (t) => t === 'setTimeout(dumpDescribe, 5e3);', fix: (l) => l.replace('setTimeout(dumpDescribe, 5e3);', 'setTimeout(dumpDescribe, 5e3).unref?.();') },
      { match: (t) => t === 'if (!stopped) timer = setTimeout(tick, minutes * 6e4);', fix: (l) => l.replace('if (!stopped) timer = setTimeout(tick, minutes * 6e4);', 'if (!stopped) { timer = setTimeout(tick, minutes * 6e4); timer.unref?.(); }') },
    ],
  },
]

function targetPath(target, dir) {
  return join(dir, ...target.file)
}

/** Apply every still-missing unref rule; returns per-target results. */
function repairUnrefPatches() {
  const dir = profileDir()
  if (dir === undefined) return { ok: false, results: [{ id: 'profile', state: 'profile-unknown' }] }
  const results = []
  for (const target of UNREF_TARGETS) {
    const file = targetPath(target, dir)
    let text
    try { text = readFileSync(file, 'utf8') } catch { results.push({ id: target.id, state: 'missing', changed: 0 }); continue }
    const lines = text.split(/\r?\n/)
    let changed = 0
    for (const rule of target.rules) {
      const matches = []
      for (let i = 0; i < lines.length; i++) if (rule.match(lines[i].trim())) matches.push(i)
      if (matches.length === 1) {
        lines[matches[0]] = rule.fix(lines[matches[0]])
        changed++
      }
    }
    if (changed > 0) {
      try { writeFileSync(file, lines.join('\n')) } catch { results.push({ id: target.id, state: 'write-failed', changed: 0 }); continue }
    }
    results.push({ id: target.id, state: changed > 0 ? 'patched' : 'ok', changed })
  }
  return { ok: true, results }
}

/** How many known unref rules are still missing per target (for status). */
function unrefStatus() {
  const dir = profileDir()
  if (dir === undefined) return []
  return UNREF_TARGETS.map((target) => {
    let text
    try { text = readFileSync(targetPath(target, dir), 'utf8') } catch { return { id: target.id, missing: -1 } }
    const lines = text.split(/\r?\n/).map((line) => line.trim())
    const missing = target.rules.filter((rule) => lines.filter((line) => rule.match(line)).length === 1).length
    return { id: target.id, missing }
  })
}

const outputShape = {
  schema: { type: 'object', additionalProperties: false, required: ['ok', 'text'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Only the local UI may trigger a market update: loopback socket, same-origin, and our custom header. */
function trustedLocalRequest(req) {
  if (req === undefined || req === null) return false
  if (!isLoopback(req.socket?.remoteAddress)) return false
  const origin = req.headers?.origin
  if (origin !== undefined && origin !== null) {
    const port = req.socket?.localPort
    if (![`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`].includes(origin)) return false
  }
  return req.headers?.['x-dsh-update-client'] === '1'
}

/** Registers POST /dsh-update-assistant/market-update for the composer dock button. */
function installMarketUpdateRoute(ctx) {
  const ws = ctx.get?.('webServer')
  if (ws === undefined || typeof ws.register !== 'function') return false
  ctx.effect(() => ws.register({
    kind: 'exact',
    path: '/dsh-update-assistant/market-update',
    handler: async (req, res) => {
      const respond = (status, payload) => {
        try {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(payload))
        } catch { /* connection gone */ }
      }
      if (req.method !== 'POST') return respond(405, { ok: false, error: 'POST only' })
      if (!trustedLocalRequest(req)) return respond(403, { ok: false, error: 'untrusted request' })
      try { for await (const _chunk of req) { /* drain */ } } catch { /* ignore */ }
      const dir = profileDir()
      const marketVersion = () => (dir === undefined ? undefined : readJson(join(dir, 'node_modules', 'dshmarket', 'package.json'))?.version)
      const before = marketVersion()
      const latest = await npmLatest('dshmarket')
      if (before !== undefined && latest !== undefined && compareVersions(latest, before) <= 0) {
        return respond(200, { ok: true, changed: false, installed: before, message: `插件市场已是最新（${before}）` })
      }
      const cli = join(installDir(), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
      try {
        run('cmd.exe', ['/c', cli, 'plugin', '--profile', 'desktop', 'add', 'dshmarket@latest'])
      } catch (error) {
        const detail = String(error?.stderr ?? error?.message ?? error).trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 300)
        appendLog(join(PLUGIN_ROOT, 'runtime', 'update.log'), 'ui market_update failed ' + detail)
        return respond(500, { ok: false, error: detail })
      }
      const after = marketVersion()
      appendLog(join(PLUGIN_ROOT, 'runtime', 'update.log'), `ui market_update ${before ?? '?'} -> ${after ?? '?'}`)
      if (before === after) return respond(200, { ok: true, changed: false, installed: after, message: `已是最新（${after ?? '未知'}）` })
      return respond(200, { ok: true, changed: true, installed: after, message: `已更新 ${before ?? '?'} → ${after}，重启 DSH 后生效` })
    },
  }))
  return true
}


export function apply(ctx) {
  ctx.logger.info('dsh-update-assistant: loaded')

  // Best-effort: a bundle replaced by an update loses its unref hotfix. Repair
  // the on-disk copies shortly after boot so the next exit is clean again.
  const startupRepair = setTimeout(() => {
    try {
      const repaired = repairUnrefPatches()
      const changed = repaired.results.filter((entry) => entry.changed > 0)
      if (changed.length > 0) appendLog(join(PLUGIN_ROOT, 'runtime', 'update.log'), 'startup unref repair: ' + changed.map((entry) => `${entry.id}x${entry.changed}`).join(', '))
    } catch { /* never block boot */ }
  }, 5000)
  startupRepair.unref?.()

  ctx.tools.register({
    name: 'update_status',
    description: '检查 DSH 桌面版更新：当前安装版本、已下载待安装的更新包、更新源最新版本，以及 desktop profile 里各插件（npm 包）已装版本 vs 最新版本，并给出建议。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: outputShape,
    async execute() {
      const [feed, versions] = await Promise.all([
        feedLatestVersion(),
        Promise.all(listPlugins().map(async (plugin) => ({ ...plugin, latest: plugin.spec.startsWith('link:') ? undefined : await npmLatest(plugin.name) }))),
      ])
      const pending = pendingUpdate()
      const current = installedVersion()
      const lines = []
      lines.push('## 桌面应用')
      lines.push(`- 已安装版本：${current ?? '未知'}`)
      if (pending === undefined) {
        lines.push('- 待安装更新：无（没有已下载的安装包）')
      } else {
        const newer = current !== undefined && pending.version !== undefined && compareVersions(pending.version, current) > 0
        lines.push(`- 待安装更新：${pending.version ?? pending.fileName}${newer ? '（比已装版本新，可安装）' : '（不高于已装版本，无需安装）'} → ${pending.path}`)
      }
      lines.push(`- 更新源最新：${feed === undefined ? '未知（无法读取 feed）' : `${feed.version}（${feed.source}）`}`)
      lines.push('')
      lines.push('## 插件（desktop profile）')
      if (versions.length === 0) lines.push('- 未找到 profile 目录（可在 DSH_PROFILE_DIR / DSH_HOME 下重试）')
      for (const plugin of versions) {
        const state = plugin.installed === undefined ? '未安装'
          : plugin.latest === undefined ? plugin.installed
            : compareVersions(plugin.latest, plugin.installed) > 0 ? `${plugin.installed} → ${plugin.latest}（可更新）`
              : `${plugin.installed}（最新）`
        lines.push(`- ${plugin.name}: ${state}`)
      }
      lines.push('')
      lines.push('## 退出阻塞补丁（unref）')
      for (const entry of unrefStatus()) {
        if (entry.missing === -1) lines.push(`- ${entry.id}: 未安装或读不到文件`)
        else if (entry.missing === 0) lines.push(`- ${entry.id}: 已就绪（无需补）`)
        else lines.push(`- ${entry.id}: 还有 ${entry.missing} 处未 unref（用 keepalive_repair 修复）`)
      }
      lines.push('')
      lines.push('## 上一次更新助手日志')
      const tail = logTail(join(PLUGIN_ROOT, 'runtime', 'update.log'))
      lines.push(tail.length > 0 ? '```\n' + tail + '\n```' : '（还没有运行记录）')
      return result(true, lines.join('\n'))
    },
  })

  ctx.tools.register({
    name: 'update_install',
    description: '安全安装已下载的 DSH 桌面版更新：先检查是否有活跃任务，再创建一个脱离 Host 进程树的一次性计划任务（结束 DSH 进程 → 静默运行安装包 → 校验版本 → 自动重启应用）。执行后当前会话会中断；会话记录在磁盘上可恢复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confirm: { type: 'boolean', description: '存在活跃任务/后台任务时是否仍然继续（默认 false，会拒绝执行）' },
        delaySeconds: { type: 'integer', minimum: 30, maximum: 900, description: '多久后开始执行，默认 120 秒' },
      },
    },
    output: outputShape,
    async execute(args) {
      const pending = pendingUpdate()
      if (pending === undefined) return result(false, '没有已下载的更新包：先在应用里点击“检查更新/下载更新”，或确认 updater 缓存目录存在 pending/update-info.json。')
      if (pending.version === undefined) return result(false, `无法从文件名识别版本，拒绝安装：${pending.fileName}`)
      const current = installedVersion()
      if (current !== undefined && compareVersions(pending.version, current) <= 0) {
        return result(false, `缓存安装包 ${pending.version} 不高于已安装版本 ${current}，无需更新；等新版本下载完成后再试。`)
      }
      if (!existsSync(pending.path)) return result(false, `缓存的安装包文件不存在：${pending.path}`)
      if (typeof pending.sha512 === 'string' && pending.sha512.length > 0) {
        const actual = sha512Base64(pending.path)
        if (actual !== pending.sha512) return result(false, '安装包完整性校验失败（sha512 与 update-info.json 不符），拒绝安装；请重新下载更新。')
      }
      const blocked = activeWorkText(ctx, '更新')
      if (blocked !== undefined && args?.confirm !== true) return result(false, blocked)
      const delay = Math.max(30, Math.min(900, Number(args?.delaySeconds ?? 120)))
      const attempt = trySchedule('install', delay, { installer: pending.path, version: pending.version })
      if (attempt.error !== undefined) return result(false, `创建计划任务失败：${attempt.error}`)
      const scheduled = attempt.scheduled
      return result(true, [
        `已安排安装 ${pending.version}。`,
        `执行时间：约 ${scheduled.at.toLocaleString('zh-CN')}（届时应用会关闭并静默安装，完成后自动重启）。`,
        `任务名：${TASK_NAME}；日志：${scheduled.logFile}`,
        '注意：本次会话会中断，历史已落盘；重启后刷新页面即可继续。',
      ].join('\n'))
    },
  })

  ctx.tools.register({
    name: 'keepalive_repair',
    description: '修复“插件常驻计时器未 unref 导致 Host 退出卡 10 秒、应用内更新被判停机不干净”的副作用：对 femo-plugin / meow-memory 的已知计时器补 .unref()（按内容定位，幂等）。补丁写盘后需要重启 Host 才真正生效。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        restart: { type: 'boolean', description: '补丁后是否自动重启让补丁生效（默认 false）' },
        confirm: { type: 'boolean', description: '存在活跃任务时是否仍然继续（默认 false）' },
        delaySeconds: { type: 'integer', minimum: 30, maximum: 900, description: '重启延迟，默认 60 秒' },
      },
    },
    output: outputShape,
    async execute(args) {
      const repaired = repairUnrefPatches()
      const lines = repaired.results.map((entry) => {
        if (entry.state === 'patched') return `- ${entry.id}: 写入 ${entry.changed} 处 unref`
        if (entry.state === 'ok') return `- ${entry.id}: 已就绪，无需修改`
        if (entry.state === 'missing') return `- ${entry.id}: 未安装或文件不存在`
        return `- ${entry.id}: ${entry.state}`
      })
      let note
      if (args?.restart === true) {
        const blocked = activeWorkText(ctx, '重启')
        if (blocked !== undefined && args?.confirm !== true) return result(false, lines.join('\n') + '\n' + blocked)
        const delay = Math.max(30, Math.min(900, Number(args?.delaySeconds ?? 60)))
        const attempt = trySchedule('restart', delay, undefined)
        if (attempt.error !== undefined) return result(false, lines.join('\n') + `\n创建计划任务失败：${attempt.error}`)
        note = `\n已安排约 ${attempt.scheduled.at.toLocaleString('zh-CN')} 重启使补丁生效（任务 ${TASK_NAME}）。`
      } else {
        const changed = repaired.results.reduce((sum, entry) => sum + (entry.changed ?? 0), 0)
        note = changed > 0
          ? '\n补丁已写盘；正在运行的 Host 仍用旧模块，需要重启后才会真正生效（可用 app_restart）。'
          : '\n没有需要补的项（都已是 unref 状态）。'
      }
      return result(true, lines.join('\n') + note)
    },
  })

  ctx.tools.register({
    name: 'market_update',
    description: '升级插件市场（dshmarket）自身：用 pnpm overlay 直接 add 目标版本——不先卸载市场（卸载会把正在运行的市场代码一起卸掉，这是 dshmarket 旧版自更新失败的原因），装完可自动重启生效。缺省安装 npm latest。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'string', description: '目标版本（默认 latest）' },
        restart: { type: 'boolean', description: '装完是否自动重启（默认 true）' },
        confirm: { type: 'boolean', description: '存在活跃任务时是否仍然继续（默认 false）' },
        delaySeconds: { type: 'integer', minimum: 30, maximum: 900, description: '重启延迟，默认 120 秒' },
      },
    },
    output: outputShape,
    async execute(args) {
      const blocked = activeWorkText(ctx, '升级市场')
      if (blocked !== undefined && args?.confirm !== true) return result(false, blocked)
      const wanted = typeof args?.version === 'string' && args.version.length > 0 ? args.version : 'latest'
      if (wanted !== 'latest' && !isSafeVersion(wanted)) return result(false, `非法版本号：${wanted}`)
      const dir = profileDir()
      const installed = dir === undefined ? undefined : readJson(join(dir, 'node_modules', 'dshmarket', 'package.json'))?.version
      const latest = await npmLatest('dshmarket')
      if (wanted === 'latest' && latest !== undefined && installed !== undefined && compareVersions(latest, installed) <= 0) {
        return result(true, `插件市场已是最新（${installed}），无需升级。`)
      }
      const spec = 'dshmarket@' + wanted
      const cli = join(installDir(), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
      const logFile = join(PLUGIN_ROOT, 'runtime', 'update.log')
      let ok = true
      let detail = ''
      try {
        run('cmd.exe', ['/c', cli, 'plugin', '--profile', 'desktop', 'add', spec])
        appendLog(logFile, 'market_update ok ' + spec)
      } catch (error) {
        ok = false
        detail = String(error?.stderr ?? error?.message ?? error).trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 300)
        appendLog(logFile, 'market_update failed ' + spec + ' ' + detail)
      }
      const after = dir === undefined ? undefined : readJson(join(dir, 'node_modules', 'dshmarket', 'package.json'))?.version
      const lines = [
        ok ? `✓ 已安装 ${spec}` : `✗ 安装 ${spec} 失败：${detail}`,
        `当前市场版本：${after ?? '未知'}`,
      ]
      const unchanged = ok && after !== undefined && installed !== undefined && after === installed
      if (unchanged) lines.push('版本没有变化（安装结果是同一版本），不安排重启。')
      else if (ok && args?.restart !== false) {
        const delay = Math.max(30, Math.min(900, Number(args?.delaySeconds ?? 120)))
        const attempt = trySchedule('restart', delay, undefined)
        if (attempt.error !== undefined) lines.push(`创建计划任务失败：${attempt.error}`)
        else lines.push(`已安排约 ${attempt.scheduled.at.toLocaleString('zh-CN')} 重启以加载新版市场（任务 ${TASK_NAME}）。`)
      } else if (ok) {
        lines.push('未安排重启：市场是 bundle，新代码要等 Host 重启后才生效。')
      }
      return result(ok, lines.join('\n'))
    },
  })

  ctx.tools.register({
    name: 'plugin_update',
    description: '更新 desktop profile 里的插件：绕过插件市场 update 的 already-installed 限制，直接用 profile 的 pnpm（dsh plugin add）安装指定 name@version；缺省自动挑选所有“已装 < npm 最新”的插件。更新完成后默认自动重启让新版本生效（插件是 bundle，需要 Host 重新加载）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targets: { type: 'array', items: { type: 'string' }, description: '要安装的包，如 ["meow-memory@0.32.1"]；缺省=自动选择所有可更新插件' },
        restart: { type: 'boolean', description: '更新后是否自动重启（默认 true）' },
        confirm: { type: 'boolean', description: '存在活跃任务时是否仍然继续（默认 false）' },
        delaySeconds: { type: 'integer', minimum: 30, maximum: 900, description: '重启延迟，默认 120 秒' },
      },
    },
    output: outputShape,
    async execute(args) {
      const blocked = activeWorkText(ctx, '更新插件')
      if (blocked !== undefined && args?.confirm !== true) return result(false, blocked)
      const installed = listPlugins()
      let targets = Array.isArray(args?.targets) ? args.targets.filter((t) => typeof t === 'string' && t.length > 0) : []
      if (targets.length === 0) {
        for (const plugin of installed) {
          if (plugin.spec.startsWith('link:') || plugin.installed === undefined) continue
          const latest = await npmLatest(plugin.name)
          if (latest !== undefined && compareVersions(latest, plugin.installed) > 0) targets.push(`${plugin.name}@${latest}`)
        }
      }
      if (targets.length === 0) return result(false, '没有可更新的插件（都已是 npm 最新，或都是本地 link: 包）。')
      const invalid = targets.find((spec) => !isSafeSpec(spec))
      if (invalid !== undefined) return result(false, `非法的包名/版本：${invalid}`)
      const cli = join(installDir(), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
      const logFile = join(PLUGIN_ROOT, 'runtime', 'update.log')
      const lines = []
      let failed = 0
      for (const spec of targets) {
        try {
          run('cmd.exe', ['/c', cli, 'plugin', '--profile', 'desktop', 'add', spec])
          lines.push(`✓ ${spec}`)
          appendLog(logFile, 'plugin_update ok ' + spec)
        } catch (error) {
          failed++
          const detail = String(error?.stderr ?? error?.message ?? error).trim().split(/\r?\n/).slice(-3).join(' / ')
          lines.push(`✗ ${spec}：${detail.slice(0, 300)}`)
          appendLog(logFile, 'plugin_update failed ' + spec + ' ' + detail)
        }
      }
      // Installing a bundle replaces its files, which drops any unref hotfix.
      const repaired = repairUnrefPatches()
      const repairedLines = repaired.results
        .filter((entry) => entry.changed > 0)
        .map((entry) => `- 已重新补 unref：${entry.id}（${entry.changed} 处）`)
      if (repairedLines.length > 0) lines.push(...repairedLines)
      let restartNote
      if (args?.restart !== false) {
        const delay = Math.max(30, Math.min(900, Number(args?.delaySeconds ?? 120)))
        const attempt = trySchedule('restart', delay, undefined)
        restartNote = attempt.error !== undefined
          ? `\n创建计划任务失败：${attempt.error}`
          : `\n已安排约 ${attempt.scheduled.at.toLocaleString('zh-CN')} 重启以加载新版本（任务 ${TASK_NAME}）。`
      } else {
        restartNote = '\n未安排重启：插件是 bundle，新版本要等 Host 重启后才生效。'
      }
      return result(failed === 0, lines.join('\n') + restartNote)
    },
  })

  ctx.tools.register({
    name: 'app_restart',
    description: '安全重启 DSH 桌面应用（不安装更新，仅用于插件更新后让 Host 重新加载）。使用与 update_install 相同的一次性计划任务机制，执行后当前会话中断。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confirm: { type: 'boolean', description: '存在活跃任务时是否仍然继续（默认 false）' },
        delaySeconds: { type: 'integer', minimum: 30, maximum: 900, description: '多久后开始执行，默认 60 秒' },
      },
    },
    output: outputShape,
    async execute(args) {
      const blocked = activeWorkText(ctx, '重启')
      if (blocked !== undefined && args?.confirm !== true) return result(false, blocked)
      const delay = Math.max(30, Math.min(900, Number(args?.delaySeconds ?? 60)))
      const attempt = trySchedule('restart', delay, undefined)
      if (attempt.error !== undefined) return result(false, `创建计划任务失败：${attempt.error}`)
      return result(true, [
        `已安排重启：约 ${attempt.scheduled.at.toLocaleString('zh-CN')}。`,
        `任务名：${TASK_NAME}；日志：${attempt.scheduled.logFile}`,
        '注意：本次会话会中断，历史已落盘；重启后刷新页面即可继续。',
      ].join('\n'))
    },
  })

  // The composer dock's update button calls this route (webServer can appear later).
  if (!installMarketUpdateRoute(ctx)) {
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (installMarketUpdateRoute(ctx) || attempts > 40) clearInterval(timer)
    }, 500)
    timer.unref?.()
  }

  ctx.on('dispose', () => {
    ctx.logger.info('dsh-update-assistant: disposed')
  })
}
