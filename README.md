# calorie counter

A food logger built as an actual agent: the model gets tools and decides which
to call, how many times, and when it is done. Not a single prompt call.

Zero npm dependencies. Node 18+ for native fetch.

## run locally

    cp .env.example .env      # paste a Gemini key
    npm install               # only pg, and only needed for Postgres
    npm run dev               # web app on localhost:3000
    npm run log               # terminal version
    npm run smoke             # exercises the loop with NO api key
    npm run seed              # demo data, so the charts have something in them
    npm run reset             # wipe the food table and the log

## the four views

- **Log** - talk to the agent, confirm a proposal, see and delete today's entries
- **Week** - calories per day with the average, tap a bar for that day's meals
  and macro split
- **Stats** - 30-day daily averages, where the energy comes from, most eaten
- **Insights** - a separate pass that reads the whole log and says what to
  change. Not a tool loop: two weeks of totals fit in one prompt, so a loop
  would only add round trips on a rate-limited free tier.

## layout

    src/agent.js    THE LOOP (~20 lines). the model's output decides if it repeats
    src/llm.js      the only file that names a provider - swap for Qwen/Groq here
    src/tools.js    the four tools, plus proposal/commit
    src/store.js    JSON files locally, Postgres (Neon) in production
    server.js       the one server, used for local dev and production
    api/            handlers: chat, commit, day, entry, range, insights
    public/         installable PWA, one HTML file
    cli.js          terminal front end
    db/schema.sql   Postgres schema
    src/migrate.js  copies local JSON into the database

## the rules that keep the numbers honest

1. **The model never does arithmetic.** It passes `{name, qty}`; JS multiplies
   the per-unit row from the table.
2. **`log_meal` cannot write.** It only proposes. Committing is a separate
   request the user triggers.
3. **Commit recomputes.** Only names and quantities cross the network, so a
   tampered client cannot log fake calories.
4. **`localDate()`, never `toISOString()`** — UTC would date a JST breakfast
   to yesterday, and a food log is entirely calendar-day-bound.

See DEPLOY.md to put it online.

## fixing the food table

The agent creates a new food whenever you phrase something differently, so
duplicates and wrong units accumulate. `src/foodfix.js` repairs both, and
rewrites the affected log entries using each entry's stored gram weight, so
history stays consistent and no calories are invented:

    npm run foods list                              # usage counts + sanity flags
    npm run foods setunit "icecream" piece 150 300  # per-100g -> per piece
    npm run foods merge "300 cal icecream" "icecream"

`list` flags a food when its macros do not add up to its calories (4 kcal/g for
protein and carbs, 9 for fat), when macros exceed 100g in a per-100g food, or
when it claims more than 900 kcal per 100g.
