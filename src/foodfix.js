// Maintenance for the food table. The agent creates a new food whenever you
// phrase something differently, so duplicates and wrong units accumulate:
//
//   node src/foodfix.js list
//   node src/foodfix.js setunit "icecream" piece 150 300
//   node src/foodfix.js merge "300 cal icecream" "icecream"
//
// Every command rewrites the affected LOG ENTRIES too, using each entry's
// stored gram weight as the source of truth, so history stays consistent and
// no calories are invented.
import { getFoods, putFood, getLog, normalize } from './store.js'
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
const round = (n) => Math.round(n * 10) / 10
const readLog = async () => JSON.parse(await readFile(join(DATA, 'log.json'), 'utf8'))
const writeLog = (v) => writeFile(join(DATA, 'log.json'), JSON.stringify(v, null, 2))
const writeFoods = (v) => writeFile(join(DATA, 'foods.json'), JSON.stringify(v, null, 2))

const basisOf = (unit) => (['g', 'ml'].includes(String(unit).toLowerCase()) ? 100 : 1)

// Rebuild one entry against a food definition, keeping the grams the user
// actually ate. That is the one fact a unit change must not alter.
function reprice(entry, food, grams) {
  const basis = basisOf(food.unit)
  const qty = basis === 100 ? grams : grams / food.grams_per_unit
  const f = qty / basis
  return {
    ...entry,
    name: food.name,
    unit: food.unit,
    qty: round(qty),
    grams: round(grams),
    kcal: Math.round(food.kcal * f),
    protein_g: round(food.protein_g * f),
    carbs_g: round(food.carbs_g * f),
    fat_g: round(food.fat_g * f),
    sugar_g: round(food.sugar_g * f),
  }
}

const [cmd, ...args] = process.argv.slice(2)
const foods = await getFoods()
const log = await readLog()

if (cmd === 'list') {
  const counts = {}
  for (const r of log) counts[r.name] = (counts[r.name] ?? 0) + 1
  const rows = Object.values(foods).map((f) => {
    // 4 kcal/g for protein and carbs, 9 for fat. A big gap means the model
    // mixed a per-100g breakdown into a per-piece food, or simply guessed.
    const fromMacros = f.protein_g * 4 + f.carbs_g * 4 + f.fat_g * 9
    const off = f.kcal ? Math.abs(fromMacros - f.kcal) / f.kcal : 0
    const flags = []
    // Below ~30 kcal the ratio is meaningless - black coffee at 5 kcal with no
    // macros is correct, not suspicious.
    if (f.kcal >= 30 && off > 0.35) flags.push(`macros imply ${Math.round(fromMacros)} kcal`)
    if (basisOf(f.unit) === 100 && f.carbs_g + f.protein_g + f.fat_g > 100) flags.push('macros exceed 100g')
    if (basisOf(f.unit) === 100 && f.kcal > 900) flags.push('over 900 kcal/100g')
    return { name: f.name, unit: f.unit, kcal: f.kcal, used: counts[f.name] ?? 0, flags }
  }).sort((a, b) => b.used - a.used)

  for (const r of rows) {
    console.log(
      `${String(r.used).padStart(3)}x  ${r.name.padEnd(36)} 1 ${String(r.unit).padEnd(8)} ${String(r.kcal).padStart(5)} kcal` +
      (r.flags.length ? `   <-- ${r.flags.join('; ')}` : '')
    )
  }
  console.log(`\n${rows.length} foods, ${rows.filter((r) => r.flags.length).length} suspicious, ` +
    `${rows.filter((r) => !r.used).length} never used`)
}

else if (cmd === 'setunit') {
  const [name, unit, gramsPerUnit, kcal] = args
  const key = normalize(name)
  const food = foods[key]
  if (!food) throw new Error(`no such food: ${name}`)

  // Macros are stated per unit, so rescale them by how much the unit grew.
  const oldPer = food.grams_per_unit * (basisOf(food.unit) === 100 ? 1 : 1)
  const ratio = (Number(gramsPerUnit) / oldPer) * (basisOf(food.unit) === 100 ? 1 : 1)
  const updated = {
    ...food,
    unit,
    grams_per_unit: Number(gramsPerUnit),
    kcal: Number(kcal),
    protein_g: round(food.protein_g * ratio),
    carbs_g: round(food.carbs_g * ratio),
    fat_g: round(food.fat_g * ratio),
    sugar_g: round(food.sugar_g * ratio),
  }
  await putFood(updated)

  let touched = 0
  const next = log.map((r) => {
    if (normalize(r.name) !== key) return r
    touched++
    return reprice(r, updated, r.grams ?? 0)
  })
  await writeLog(next)
  console.log(`${food.name}: 1 ${food.unit} (${food.grams_per_unit}g, ${food.kcal} kcal)`)
  console.log(`        -> 1 ${unit} (${gramsPerUnit}g, ${kcal} kcal), ${touched} entries rewritten`)
}

else if (cmd === 'merge') {
  const [from, into] = args
  const a = normalize(from), b = normalize(into)
  const target = foods[b]
  if (!foods[a]) throw new Error(`no such food: ${from}`)
  if (!target) throw new Error(`no such food: ${into}`)

  let touched = 0
  const next = log.map((r) => {
    if (normalize(r.name) !== a) return r
    touched++
    return reprice(r, target, r.grams ?? 0)
  })
  await writeLog(next)
  delete foods[a]
  await writeFoods(foods)
  console.log(`merged "${from}" into "${into}": ${touched} entries repointed, food removed`)
}

else {
  console.log('usage: foodfix list | setunit <food> <unit> <grams> <kcal> | merge <from> <into>')
}
