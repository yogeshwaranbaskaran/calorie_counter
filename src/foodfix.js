// Maintenance for a user's food table, against the live database.
//
//   npm run foods list                          usage counts + sanity flags
//   npm run foods dupes                         likely duplicates, with the merge command
//   npm run foods rename "old name" "new name"
//   npm run foods merge  "from" "into"          repoints history to "into", removes "from"
//   npm run foods set    "name" kcal=121 protein_g=20 fat_g=4.5 unit=g grams_per_unit=100
//   npm run foods delete "name"                 only if nothing in the log uses it
//
// History is repointed BY NAME ONLY. What you ate on a day stays exactly as it
// was logged that day; a corrected food applies from the next log onward.
// Rewriting past calories to match a later correction would make the weight
// trend and the intake it is compared against disagree.
//
// Scope: the owner (OWNER_EMAIL), or FOODFIX_USER=<id>; user_id NULL in
// single-user mode.
import { sql, usingPostgres, getFoods, putFood, normalize } from './store.js'
import { similarity } from './tools.js'

const round = (n) => Math.round(n * 10) / 10
const basisOf = (unit) => (['g', 'ml'].includes(String(unit).toLowerCase()) ? 100 : 1)

async function whoami() {
  if (!usingPostgres()) return null
  if (process.env.FOODFIX_USER) return Number(process.env.FOODFIX_USER)
  const owner = (process.env.OWNER_EMAIL || '').toLowerCase()
  if (owner) {
    const r = await sql('select id from users where lower(email) = $1', [owner])
    if (r[0]) return r[0].id
  }
  const users = await sql('select id, email from users order by id')
  if (users.length === 1) return users[0].id
  if (!users.length) return null
  throw new Error(`several users - set OWNER_EMAIL or FOODFIX_USER. ${users.map((u) => `${u.id}=${u.email}`).join(', ')}`)
}

const userId = await whoami()
const U = 'user_id is not distinct from $1'
const [cmd, ...args] = process.argv.slice(2)

const usage = async () => {
  const rows = await sql(`select name, count(*)::int n from log_entries where ${U} group by name`, [userId])
  return Object.fromEntries(rows.map((r) => [r.name, r.n]))
}

if (cmd === 'list') {
  const foods = Object.values(await getFoods(userId))
  const used = await usage()
  const rows = foods.map((f) => {
    const implied = f.protein_g * 4 + f.carbs_g * 4 + f.fat_g * 9
    const flags = []
    if (f.kcal >= 30 && Math.abs(implied - f.kcal) / f.kcal > 0.35) flags.push(`macros imply ${Math.round(implied)} kcal`)
    if (basisOf(f.unit) === 100 && f.protein_g + f.carbs_g + f.fat_g > 100) flags.push('macros exceed 100g')
    if (basisOf(f.unit) === 100 && f.kcal > 900) flags.push('over 900 kcal/100g')
    if (/\d/.test(f.name)) flags.push('number in name')
    return { ...f, used: used[f.name] ?? 0, flags }
  }).sort((a, b) => b.used - a.used || a.name.localeCompare(b.name))
  for (const r of rows) {
    console.log(`${String(r.used).padStart(3)}x  ${r.name.padEnd(34)} 1 ${String(r.unit).padEnd(7)} ${String(r.grams_per_unit).padStart(4)}g ${String(r.kcal).padStart(5)} kcal  P${String(r.protein_g).padEnd(5)}C${String(r.carbs_g).padEnd(6)}F${String(r.fat_g).padEnd(5)}${r.flags.length ? '  <-- ' + r.flags.join('; ') : ''}`)
  }
  console.log(`\n${rows.length} foods, ${rows.filter((r) => r.flags.length).length} flagged, ${rows.filter((r) => !r.used).length} never used`)
}

else if (cmd === 'dupes') {
  const names = Object.keys(await getFoods(userId))
  const used = await usage()
  const pairs = []
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const score = similarity(names[i], names[j])
    if (score >= 0.8) pairs.push({ a: names[i], b: names[j], score })
  }
  pairs.sort((x, y) => y.score - x.score)
  for (const { a, b, score } of pairs) {
    const [into, from] = (used[a] ?? 0) >= (used[b] ?? 0) ? [a, b] : [b, a]
    console.log(`${score.toFixed(2)}  "${from}" (${used[from] ?? 0}x)  ->  "${into}" (${used[into] ?? 0}x)`)
    console.log(`        npm run foods merge ${JSON.stringify(from)} ${JSON.stringify(into)}`)
  }
  console.log(`\n${pairs.length} candidate pairs at >= 0.80`)
}

else if (cmd === 'rename') {
  const [from, to] = args.map(normalize)
  const foods = await getFoods(userId)
  if (!foods[from]) throw new Error(`no such food: ${from}`)
  if (foods[to]) throw new Error(`"${to}" already exists - use merge`)
  await sql(`update foods set name = $2 where ${U} and name = $3`, [userId, to, from])
  const r = await sql(`update log_entries set name = $2 where ${U} and name = $3 returning id`, [userId, to, from])
  console.log(`renamed "${from}" -> "${to}", ${r.length} log entries repointed`)
}

else if (cmd === 'merge') {
  const [from, into] = args.map(normalize)
  const foods = await getFoods(userId)
  if (!foods[from]) throw new Error(`no such food: ${from}`)
  if (!foods[into]) throw new Error(`no such food: ${into}`)
  const r = await sql(`update log_entries set name = $2 where ${U} and name = $3 returning id`, [userId, into, from])
  await sql(`delete from foods where ${U} and name = $2`, [userId, from])
  console.log(`merged "${from}" into "${into}": ${r.length} log entries repointed, food removed`)
}

else if (cmd === 'set') {
  const [rawName, ...kv] = args
  const name = normalize(rawName)
  const foods = await getFoods(userId)
  const food = foods[name]
  if (!food) throw new Error(`no such food: ${name}`)
  const next = { ...food }
  for (const pair of kv) {
    const [k, v] = pair.split('=')
    if (!['unit', 'grams_per_unit', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g'].includes(k)) throw new Error(`unknown field ${k}`)
    next[k] = k === 'unit' ? v : Number(v)
  }
  await putFood(userId, next)
  console.log(`${name}: 1 ${next.unit} (${next.grams_per_unit}g) = ${next.kcal} kcal  P${next.protein_g} C${next.carbs_g} F${next.fat_g} S${next.sugar_g}`)
}

else if (cmd === 'delete') {
  const name = normalize(args[0])
  const used = await usage()
  if (used[name]) throw new Error(`"${name}" is used by ${used[name]} log entries - merge it instead`)
  const r = await sql(`delete from foods where ${U} and name = $2 returning id`, [userId, name])
  console.log(r.length ? `deleted "${name}"` : `no such food: ${name}`)
}

else {
  console.log('usage: foods list | dupes | rename <from> <to> | merge <from> <into> | set <name> k=v ... | delete <name>')
}
process.exit(0)
