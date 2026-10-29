# calorie counter

A food and weight tracker you talk to. You type "2 chapati and dal", it works
out what that is, shows you the numbers, and you confirm them.

Live: https://calorie-counter-oit1.onrender.com

The point of the project is the middle part. It is a real tool-calling loop,
not one prompt and one answer: the model gets five tools, and its own output
decides whether the loop runs again. Everything else is built around keeping
the numbers that come out of it honest.

Node 20+, one npm dependency (`pg`). No framework, no bundler, no build step.

## running it

    cp .env.example .env     # paste a Gemini API key
    npm install
    npm run dev              # http://localhost:3000
    npm run log              # same agent, terminal front end
    npm run smoke            # runs the loop against a stub model, no key needed

With `DATABASE_URL` empty it stores everything in JSON files under `data/`,
so you can run it with nothing but a Gemini key. Set `DATABASE_URL` and it
uses Postgres instead; the storage layer is the only thing that changes.

## the loop

`src/agent.js`, about twenty lines of control flow:

```js
for (let step = 0; step < MAX_STEPS; step++) {
  const { text, calls } = await complete({ system, messages: history, tools })
  history.push({ role: 'model', text, calls })
  if (calls.length === 0) return text          // model says it is done
  for (const call of calls) {
    history.push({ role: 'tool', name: call.name, result: await tools[call.name](call.args) })
  }
}
```

The five tools:

| tool | what it does |
|---|---|
| `lookup_food` | your own table first, because your corrections beat any database |
| `search_library` | 8,061 USDA foods, per 100g, measured. Raw ingredients only |
| `save_food` | writes a new food, with the model's estimate, once |
| `log_meal` | proposes a meal. Cannot write |
| `query_history` | "how much protein did I average last week" |

A typical first-time food is two calls and about ten seconds. A food you have
eaten before is one call and under a second, because it never reaches the
model's estimate at all.

## the rules that keep the numbers honest

These are the actual constraints in the code, and most of them exist because
the obvious version was wrong first.

1. **The model never does arithmetic.** It passes `{name, qty}`. JavaScript
   multiplies the per-unit row from the table. An LLM that is asked for
   `180 * 4` will usually be right, and "usually" is not a nutrition tracker.

2. **`log_meal` cannot write.** It parks a proposal. Committing is a separate
   request that the user triggers by tapping a card, so nothing lands in the
   log that the user did not look at.

3. **Commit recomputes from the database.** Only names and quantities cross
   the network. A tampered client cannot log a thousand fake calories.

4. **`localDate()`, never `toISOString()`.** A food log is entirely
   calendar-day bound, and UTC dates a 07:00 breakfast in Tokyo to yesterday.
   The client sends its own date; the server trusts it only within one day.

5. **Corrections are per-food and forward-only.** Fix the calories on a card
   and that food is right from then on. Days you already logged keep the
   numbers they were logged with, because that is what you actually ate
   against at the time.

## where a number comes from, in order

1. **Your own table.** Foods you confirmed or corrected. Always checked first.
2. **The USDA library.** 8,061 foods from FoodData Central (SR Legacy +
   Foundation, public domain), per 100g. Raw ingredients: meat, eggs, grains,
   dairy, fruit, vegetables.
3. **The model's estimate.** Only for cooked dishes the library has no row
   for, which is most Indian home cooking. It says what it assumed, in one
   line, and you correct it once.

Rebuild the library with `node src/usda-extract.js <csv dirs>` then
`npm run library:load`.

## layout

    src/agent.js     the loop. The model's output decides if it repeats
    src/llm.js       the only file that names a provider. Swap it to change model
    src/tools.js     the five tools, plus proposal and commit
    src/store.js     JSON files locally, Postgres in production. One interface
    src/auth.js      Google OAuth, signed session cookies, key encryption
    src/insights.js  the one place that is not a loop (see below)
    server.js        one server, same code locally and in production
    api/             one file per route: chat, commit, day, range, body, ...
    public/          installable PWA, a single HTML file, no build step
    cli.js           terminal front end over the same agent
    db/              Postgres schema and migrations (npm run db:migrate)

### four screens

**Log** talks to the agent and shows today. **Trends** is calories per day
with the rolling average. **Body** is weight, a 7-day trend line and progress
against targets. **Insights** reads the whole log and says what to change.

Insights is deliberately *not* a tool loop. Two weeks of totals fit in one
prompt, so a loop would only add round trips on a rate-limited free tier.
Agents are a technique, not a default.

## accounts and keys

Google sign-in, hand-rolled OAuth 2.0, no auth library. Sessions are
HMAC-signed cookies compared with `timingSafeEqual`.

Each user brings their own Gemini API key, which is what makes the hosted
version free to run. Keys are encrypted at rest with AES-256-GCM, and are
never returned to the browser: the client only ever learns a `hasKey` boolean.
Before a key is saved the server spends one real call on it, so a typo fails
on the setup screen instead of on the user's first meal.

Without Google credentials configured the app runs single-user behind
`APP_PASSCODE`, which is how it started.

## notes from running it in production

Three people use this daily, two of them in India, and most of the recent
commits come from that rather than from new features.

- **A free Render instance sleeps after 15 minutes.** The first open takes
  30 to 60 seconds. Nothing in the app can fix that; a cron ping on
  `/api/health` moves the cost to the ping.
- **Mobile carriers drop connections they consider idle**, sometimes inside a
  minute, and a food the table has never seen leaves the request silent for
  10 to 30 seconds while the agent works. `/api/chat` answers with headers
  immediately and writes a heartbeat line every few seconds; the real payload
  is the last line. A busy connection does not get dropped.
- **The fallback chain is ordered by measured latency, not by model number.**
  It was not, once, and a struggling primary model fell through to the
  slowest option before it reached the fastest one.
- **Connection pooling is most of the database bill.** A fresh TLS connection
  to another continent costs about 800ms, and a 30 second idle timeout meant
  nearly every request paid it. Holding connections for 15 minutes fixed the
  latency and, on a per-compute-hour database plan, cost a month's quota in
  16 days. Both numbers are in `src/store.js`.

## deploying

`DEPLOY.md`. It is Render plus any Postgres; `render.yaml` sets the region,
health check and environment variables. Roughly 30 minutes, most of it in
Google Cloud Console setting up OAuth.

## state

Working and in daily use. `ROADMAP.md` has what is deliberately not built
yet and why. Nutrition estimates for cooked dishes are a model's guess, not
measured data, and the app says so rather than pretending otherwise.

MIT licensed.
