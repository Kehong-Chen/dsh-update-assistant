// Read-only smoke test for dsh-update-assistant.
// Loads the plugin with a fake Cordis context, registers every tool and runs
// the two safe ones (update_status / keepalive_repair). It never schedules a
// task and never touches the app.
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
for (const name of ['update_status', 'keepalive_repair']) {
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

const guard = await byName.get('plugin_update').execute({ targets: ['bad&spec'], restart: false }, {})
console.log('\n===== invalid spec guard =====')
console.log(guard.ok === false ? 'ok: rejected' : 'FAIL: not rejected')
if (guard.ok !== false) process.exitCode = 1
