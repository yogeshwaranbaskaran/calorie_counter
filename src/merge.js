// Merge a dump from the OLD database into the LIVE one.
//   node --env-file=.env src/merge.js data/dump-....json --dry-run
//   node --env-file=.env src/merge.js data/dump-....json
//
// DATABASE_URL is the TARGET (the live database). The dump is the source.
//
// This is not restore.js. Restoring assumes an empty target and keeps the
// source's ids. Here both sides have been written to independently, so ids
// mean different things in each: Neon's user 1 and Supabase's user 1 are not
// the same person. Every row therefore gets a FRESH id from the target's own
// sequence, and the only thing carried across is WHICH USER it belongs to,
// resolved through google_sub - the one key Google guarantees is stable and
// that 002_users.sql declares unique.
//
// Where the two sides disagree, the TARGET wins: it is the copy people have
// been using. So a user who exists in both keeps their live row (their key,
// their targets), and a food name they have already relearned keeps the live
// numbers. The dump only fills in what is missing.
import pg from 'pg'
import { readFile } from 'node:fs/promises'

const file = process.argv[2]
const dry = process.argv.includes('--dry-run')
const allowOverlap = process.argv.includes('--allow-overlap')
const adoptArg = process.argv.find((a) => a.startsWith('--adopt='))
const adopt = adoptArg ? Number(adoptArg.slice('--adopt='.length)) : null

if (!file || !process.env.DATABASE_URL) {
  console.error('usage: node --env-file=.env src/merge.js <dump.json> [--dry-run] [--adopt=<target user id>] [--allow-overlap]')
  process.exit(1)
}

const dump = JSON.parse(await readFile(file, 'utf8'))
const src = dump.tables
console.log(`dump taken ${dump.taken_at}`)
console.log(`source rows: ` + Object.entries(src).map(([t, r]) => `${t} ${r.length}`).join(', '))
if (dry) console.log('\n*** DRY RUN - everything rolls back at the end ***')

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
})
const c = await db.connect()

// Only insert columns the target actually has. A dump taken before a migration
// would otherwise fail on an unknown column with a far less obvious message.
const columnsOf = async (t) => (await c.query(
  `select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [t]
)).rows.map((r) => r.column_name)

const insert = async (table, row, cols, conflict) => {
  const keys = Object.keys(row).filter((k) => k !== 'id' && cols.includes(k))
  const sql = `insert into ${table} (${keys.map((k) => `"${k}"`).join(',')})
               values (${keys.map((_, i) => `$${i + 1}`).join(',')})
               ${conflict ? `on conflict ${conflict} do nothing` : ''} returning id`
  const { rows } = await c.query(sql, keys.map((k) => row[k]))
  return rows.length > 0 // false means a conflict swallowed it
}

const stats = {}
const bump = (k, n = 1) => (stats[k] = (stats[k] ?? 0) + n)

try {
  await c.query('begin')

  /* ---- users: match on google_sub, never overwrite a live row ---- */
  const userCols = await columnsOf('users')
  const map = new Map() // source user id -> target user id

  for (const u of src.users ?? []) {
    const found = await c.query('select id, email from users where google_sub = $1', [u.google_sub])
    if (found.rows.length) {
      map.set(String(u.id), found.rows[0].id)
      bump('users matched')
      console.log(`  user ${u.id} -> ${found.rows[0].id}  (already here, live row kept)`)
    } else {
      const keys = Object.keys(u).filter((k) => k !== 'id' && userCols.includes(k))
      const { rows } = await c.query(
        `insert into users (${keys.map((k) => `"${k}"`).join(',')})
         values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
        keys.map((k) => u[k]))
      map.set(String(u.id), rows[0].id)
      bump('users created')
      console.log(`  user ${u.id} -> ${rows[0].id}  (new here, row carried over)`)
    }
  }

  /* ---- rows with no owner (pre-accounts data) need an explicit decision ---- */
  const orphans = ['foods', 'log_entries', 'weights']
    .flatMap((t) => (src[t] ?? []).filter((r) => r.user_id === null).map(() => t))
  if (orphans.length) {
    const byTable = orphans.reduce((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {})
    if (adopt === null) {
      throw new Error(
        `${orphans.length} rows have user_id = NULL (${Object.entries(byTable).map(([t, n]) => `${t} ${n}`).join(', ')}).\n` +
        `  These predate accounts and belong to nobody. Re-run with --adopt=<target user id> to give them\n` +
        `  to a user, and check that id first with: select id, email from users;`)
    }
    const ok = await c.query('select id from users where id = $1', [adopt])
    if (!ok.rows.length) throw new Error(`--adopt=${adopt} is not a user in the target database`)
    map.set('null', adopt)
    console.log(`  ${orphans.length} ownerless rows will be adopted by user ${adopt}`)
  }

  const owner = (v) => {
    const key = v === null ? 'null' : String(v)
    if (!map.has(key)) throw new Error(`source user_id ${v} has no mapping; its users row is missing from the dump`)
    return map.get(key)
  }

  /* ---- log_entries must not double-log a day that exists on both sides ---- */
  const srcDays = new Set((src.log_entries ?? []).map((r) => String(r.date).slice(0, 10)))
  if (srcDays.size) {
    const { rows: clash } = await c.query(
      `select distinct to_char(date,'YYYY-MM-DD') d from log_entries where to_char(date,'YYYY-MM-DD') = any($1)`,
      [[...srcDays]])
    if (clash.length && !allowOverlap) {
      throw new Error(
        `${clash.length} day(s) have entries on BOTH sides: ${clash.slice(0, 6).map((r) => r.d).join(', ')}${clash.length > 6 ? ' ...' : ''}\n` +
        `  Merging would log those meals twice. Delete one side's rows for those days, or pass --allow-overlap\n` +
        `  if you have checked them and they really are different meals.`)
    }
  }

  /* ---- children: fresh ids, remapped owner, target wins on conflict ---- */
  for (const [table, conflict] of [
    ['foods', '(user_id, name)'],       // foods_user_name_idx
    ['weights', '(user_id, date)'],     // weights_user_date_idx
    ['log_entries', null],              // append-only, no natural key
  ]) {
    const cols = await columnsOf(table)
    for (const row of src[table] ?? []) {
      const written = await insert(table, { ...row, user_id: owner(row.user_id) }, cols, conflict)
      bump(written ? `${table} inserted` : `${table} skipped (already there)`)
    }
  }

  console.log('\nresult:')
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(34)} ${String(v).padStart(5)}`)

  console.log('\ntotals in the target now:')
  for (const t of ['users', 'foods', 'log_entries', 'weights']) {
    const { rows } = await c.query(`select count(*)::int n from ${t}`)
    console.log(`  ${t.padEnd(14)} ${String(rows[0].n).padStart(5)}`)
  }

  if (dry) {
    await c.query('rollback')
    console.log('\nDRY RUN - rolled back, nothing changed. Re-run without --dry-run to keep it.')
  } else {
    await c.query('commit')
    console.log('\ncommitted.')
  }
} catch (err) {
  await c.query('rollback').catch(() => {})
  console.error(`\nROLLED BACK, nothing changed:\n  ${err.message}`)
  process.exitCode = 1
} finally {
  c.release()
  await db.end()
}
