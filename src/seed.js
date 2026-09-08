// Fills the log with plausible demo data so the week and stats views have
// something in them before you have logged two weeks yourself.
// `npm run seed` to fill, `npm run reset` to wipe it.
import { putFood, appendLog, localDate } from './store.js'

const FOODS = [
  { name: 'dosa',          unit: 'piece', grams_per_unit: 80,  kcal: 130, protein_g: 3,   carbs_g: 23, fat_g: 3.5, sugar_g: 0.5 },
  { name: 'idli',          unit: 'piece', grams_per_unit: 40,  kcal: 58,  protein_g: 1.6, carbs_g: 12, fat_g: 0.2, sugar_g: 0.1 },
  { name: 'sambar',        unit: 'bowl',  grams_per_unit: 200, kcal: 120, protein_g: 5,   carbs_g: 18, fat_g: 3,   sugar_g: 4 },
  { name: 'filter coffee', unit: 'cup',   grams_per_unit: 150, kcal: 90,  protein_g: 2,   carbs_g: 12, fat_g: 3.5, sugar_g: 11 },
  { name: 'curd rice',     unit: 'bowl',  grams_per_unit: 300, kcal: 330, protein_g: 9,   carbs_g: 55, fat_g: 8,   sugar_g: 5 },
  { name: 'chapati',       unit: 'piece', grams_per_unit: 45,  kcal: 120, protein_g: 3.5, carbs_g: 20, fat_g: 3,   sugar_g: 0.4 },
  { name: 'egg',           unit: 'piece', grams_per_unit: 50,  kcal: 78,  protein_g: 6.3, carbs_g: 0.6, fat_g: 5.3, sugar_g: 0.4 },
  { name: 'chicken curry', unit: 'bowl',  grams_per_unit: 250, kcal: 340, protein_g: 27,  carbs_g: 9,  fat_g: 22,  sugar_g: 4 },
  { name: 'banana',        unit: 'piece', grams_per_unit: 118, kcal: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4, sugar_g: 14 },
  { name: 'biryani',       unit: 'plate', grams_per_unit: 350, kcal: 580, protein_g: 22,  carbs_g: 78, fat_g: 19,  sugar_g: 3 },
]

const DAYS = [
  [['idli', 3], ['sambar', 1], ['filter coffee', 1], ['curd rice', 1], ['banana', 1]],
  [['dosa', 2], ['sambar', 1], ['filter coffee', 2], ['chapati', 3], ['chicken curry', 1]],
  [['idli', 2], ['filter coffee', 1], ['biryani', 1]],
  [['egg', 2], ['chapati', 2], ['filter coffee', 1], ['curd rice', 1]],
  [['dosa', 3], ['sambar', 1], ['filter coffee', 2], ['banana', 2]],
  [['idli', 4], ['sambar', 1], ['chicken curry', 1], ['filter coffee', 1]],
  [], // a day you forgot to log - the charts must survive it
  [['egg', 3], ['chapati', 2], ['filter coffee', 1], ['banana', 1], ['curd rice', 1]],
  [['dosa', 2], ['sambar', 1], ['biryani', 1], ['filter coffee', 2]],
  [['idli', 3], ['sambar', 1], ['filter coffee', 1], ['chapati', 2], ['chicken curry', 1]],
]

const round = (n) => Math.round(n * 10) / 10
const shift = (days) => {
  const d = new Date(); d.setDate(d.getDate() + days)
  return localDate(d)
}

const byName = Object.fromEntries(FOODS.map((f) => [f.name, f]))
for (const f of FOODS) await putFood(null, f)

const rows = []
DAYS.forEach((meals, i) => {
  const date = shift(-(DAYS.length - 1 - i))
  for (const [name, qty] of meals) {
    const f = byName[name]
    rows.push({
      date, name, qty, unit: f.unit,
      grams: round(f.grams_per_unit * qty),
      kcal: Math.round(f.kcal * qty),
      protein_g: round(f.protein_g * qty),
      carbs_g: round(f.carbs_g * qty),
      fat_g: round(f.fat_g * qty),
      sugar_g: round(f.sugar_g * qty),
    })
  }
})
await appendLog(null, rows)
console.log(`seeded ${FOODS.length} foods and ${rows.length} entries across ${DAYS.length} days`)
