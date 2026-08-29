# health agent

A food logger built as an actual agent: the model gets tools and decides which
to call, how many times, and when it is done. Not a single prompt call.

Zero npm dependencies. Node 18+ for native fetch.

## run locally

    cp .env.example .env      # paste a Gemini key
    npm run log               # terminal version
    npm run dev               # web app on localhost:3000
    npm run smoke             # exercises the loop with NO api key

## layout

    src/agent.js    THE LOOP (~20 lines). the model's output decides if it repeats
    src/llm.js      the only file that names a provider - swap for Qwen/Groq here
    src/tools.js    the four tools, plus proposal/commit
    src/store.js    JSON files locally, Supabase in production. same interface
    api/            serverless functions: chat, commit, day
    public/         installable PWA, one HTML file
    cli.js          terminal front end
    supabase/       schema

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
