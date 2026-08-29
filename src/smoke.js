// Drives the real loop, real tools and real store against a SCRIPTED model,
// so everything but the network call is proven. Run: node src/smoke.js
import { runTurn } from './agent.js'
import { makeTools } from './tools.js'
import { getFoods, getLog } from './store.js'

const script = [
  { text: '', calls: [{ name: 'lookup_food', args: { names: ['dosa', 'sambar'] } }] },
  { text: '', calls: [
      { name: 'save_food', args: { name: 'dosa', unit: 'piece', grams_per_unit: 120, kcal: 168, protein_g: 3.6, carbs_g: 30, fat_g: 3.7, sugar_g: 0.5 } },
      { name: 'save_food', args: { name: 'sambar', unit: 'bowl', grams_per_unit: 150, kcal: 95, protein_g: 4.2, carbs_g: 13, fat_g: 2.8, sugar_g: 2.1 } },
  ] },
  { text: '', calls: [{ name: 'log_meal', args: { date: '2026-08-24', items: [{ name: 'dosa', qty: 2 }, { name: 'sambar', qty: 1 }] } }] },
  { text: '431 kcal, 11.4g protein. Logged.', calls: [] },
]

let i = 0
const complete = async () => script[i++]

const history = [{ role: 'user', text: '2 dosa and sambar' }]
const reply = await runTurn({
  history,
  tools: makeTools({ propose: async (p) => { console.log("  proposal:", p.totals); return { written: true } } }),
  onToolCall: (c) => console.log(`  tool: ${c.name}(${JSON.stringify(c.args).slice(0, 90)})`),
  complete,
})

console.log('\nreply:', reply)
console.log('steps taken:', i)
console.log('foods learned:', Object.keys(await getFoods()))
console.log('log rows:', JSON.stringify(await getLog(), null, 1))
