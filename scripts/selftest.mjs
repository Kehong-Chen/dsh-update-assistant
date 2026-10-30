// Read-only smoke test for dsh-update-assistant.
//
// Loads the plugin with a fake Cordis context, registers every tool, then runs
// only the calls that touch no file and schedule no task:
//   - update_status (network reads)
//   - the input guards of plugin_update / market_update
//
// keepalive_repair is deliberately NOT executed here: it writes third-party
// bundles; exercise it through the real tool instead.
//
//   node scripts/selftest.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)

const tools = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(tool) { tools.push(tool) } },
  get() { return undefined },
  on() {},
}

mod.apply(ctx)
console.log('tool count:', tools.length)
for (const tool of tools) console.log(' -', tool.name)

const byName = new Map(tools.map((tool) => [tool.name, tool]))
for (const name of ['update_status']) {
  const tool = byName.get(name)
  if (tool === undefined) {
    console.error(`missing tool: ${name}`)
    process.exitCode = 1
    continue
  }
  console.log(`\n===== ${name} =====`)
  const out = await tool.execute({}, {})
  console.log(out.text)
}

const cases = [
  ['plugin_update rejects shell metacharacters', 'plugin_update', { targets: ['bad&spec'], restart: false }],
  ['market_update rejects a bad version', 'market_update', { version: '1.0"&calc' }],
]

for (const [label, name, args] of cases) {
  const out = await byName.get(name).execute(args, {})
  console.log(`\n===== ${label} =====`)
  console.log(out.ok === false ? 'ok: rejected' : 'FAIL: not rejected')
  if (out.ok !== false) process.exitCode = 1
}
