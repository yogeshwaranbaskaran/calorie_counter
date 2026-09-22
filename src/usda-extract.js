// Turns a USDA FoodData Central CSV dump into data/usda.json - one row per
// food, per 100g: { fdc_id, name, category, source, kcal, protein_g, carbs_g,
// fat_g, sugar_g, fiber_g }. Run once after downloading; commit the output.
//
//   node src/usda-extract.js <dir-with-food.csv> [<another dir> ...]
//
// USDA data is public domain (CC0). Nutrient ids are stable across releases:
// 1008 energy kcal, 1003 protein, 1005 carbohydrate, 1004 fat, 2000 sugars,
// 1079 fiber. Foundation Foods sometimes lack 1008 and carry only the
// Atwater-specific energy ids, so kcal falls back to 4/4/9 from the macros.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WANT = { 1008: 'kcal', 1003: 'protein_g', 1005: 'carbs_g', 1004: 'fat_g', 2000: 'sugar_g', 1079: 'fiber_g' }

// A small RFC-4180 reader: quoted fields may contain commas and newlines.
function* csvRows(path) {
  const text = readFileSync(path, 'utf8')
  let row = [], field = '', q = false, i = 0
  const push = () => { row.push(field); field = '' }
  while (i < text.length) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue }
      if (c === '"') { q = false; i++; continue }
      field += c; i++; continue
    }
    if (c === '"') { q = true; i++; continue }
    if (c === ',') { push(); i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { push(); yield row; row = []; i++; continue }
    field += c; i++
  }
  if (field || row.length) { push(); yield row }
}

function readTable(path) {
  const it = csvRows(path)
  const header = it.next().value
  const rows = []
  for (const r of it) rows.push(Object.fromEntries(header.map((h, i) => [h, r[i]])))
  return rows
}

const out = new Map()
for (const dir of process.argv.slice(2)) {
  const source = /foundation/i.test(dir) ? 'usda_foundation' : /legacy/i.test(dir) ? 'usda_sr_legacy' : 'usda'
  const categories = Object.fromEntries(readTable(join(dir, 'food_category.csv')).map((c) => [c.id, c.description]))

  // Foundation's food.csv also lists thousands of lab sub-samples; only the
  // ids in foundation_food.csv are real foods. SR Legacy's food.csv is clean.
  let keep = null
  try { keep = new Set(readTable(join(dir, 'foundation_food.csv')).map((r) => r.fdc_id)) } catch {}

  const foods = {}
  for (const f of readTable(join(dir, 'food.csv'))) {
    if (keep && !keep.has(f.fdc_id)) continue
    foods[f.fdc_id] = { fdc_id: Number(f.fdc_id), name: f.description, category: categories[f.food_category_id] ?? null, source }
  }

  let n = 0
  for (const fn of readTable(join(dir, 'food_nutrient.csv'))) {
    const key = WANT[fn.nutrient_id]
    const food = foods[fn.fdc_id]
    if (!key || !food) continue
    const v = Number(fn.amount)
    if (!Number.isFinite(v)) continue
    // Foundation can carry several measurements per nutrient; keep the first.
    if (food[key] === undefined) { food[key] = Math.round(v * 10) / 10; n++ }
  }

  for (const food of Object.values(foods)) {
    if (food.protein_g === undefined && food.carbs_g === undefined && food.fat_g === undefined) continue
    for (const k of ['protein_g', 'carbs_g', 'fat_g', 'sugar_g', 'fiber_g']) food[k] ??= 0
    if (food.kcal === undefined) food.kcal = Math.round(food.protein_g * 4 + food.carbs_g * 4 + food.fat_g * 9)
    // Foundation is the better measurement where both cover the same food
    // name; it is loaded second and wins.
    out.set(food.name.toLowerCase(), food)
  }
  console.log(`${source.padEnd(18)} ${Object.keys(foods).length} foods, ${n} nutrient values read`)
}

const rows = [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'usda.json')
writeFileSync(dest, JSON.stringify(rows))
console.log(`wrote ${rows.length} foods -> ${dest} (${(readFileSync(dest).length / 1024 / 1024).toFixed(1)} MB)`)
