// Terminal front end. Handy for testing the loop without a browser.
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { runTurn } from './src/agent.js'
import { makeTools } from './src/tools.js'
import { appendLog, getFoods, backend } from './src/store.js'

const rl = createInterface({ input: stdin, output: stdout })
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

// The CLI's confirm gate: ask inline, write only on yes.
const propose = async ({ date, rows, totals }) => {
  console.log(
    `\n  ${date}\n` +
      rows.map((r) => `  - ${r.qty} x ${r.name} (${r.grams}g) = ${r.kcal} kcal`).join('\n') +
      `\n  total ${totals.kcal} kcal, ${totals.protein_g}g protein`
  )
  const answer = await rl.question(`\n  write this? ${dim('(y/n)')} `)
  if (!/^y/i.test(answer.trim())) return { written: false, reason: 'user_declined' }
  await appendLog(null, rows)
  return { written: true, entries: rows.length, ...totals }
}

const tools = makeTools({ propose })
const history = []

console.log(bold('\n  calorie counter'))
console.log(dim(`  ${Object.keys(await getFoods(null)).length} foods known (${backend()}). ctrl-c to quit.\n`))

while (true) {
  const said = (await rl.question(bold('> '))).trim()
  if (!said) continue
  if (['q', 'quit', 'exit'].includes(said.toLowerCase())) break
  history.push({ role: 'user', text: said })
  try {
    const reply = await runTurn({
      history,
      tools,
      // Printing every tool call is the point - you watch the model decide.
      onToolCall: (c) => console.log(dim(`  ${c.name}(${JSON.stringify(c.args)})`)),
    })
    console.log(`\n${reply}\n`)
  } catch (err) {
    console.log(dim(`\n  ${err.message}\n`))
  }
}
rl.close()
