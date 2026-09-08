# deploy — Neon + Render

Five steps, roughly 30 minutes. Everything here needs a browser, so it is
yours to do; the code side is finished and tested against a real Postgres.

---

## 1. Neon — the database

1. Sign up at **neon.tech**, create a project (any region near you; Singapore
   or Tokyo if offered).
2. Copy the **pooled** connection string. It looks like:

   ```
   postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
   ```

   Use the **pooler** one (it has `-pooler` in the host). That is what a
   free-tier server with a small connection pool should talk to.

3. Create the tables: open Neon's **SQL Editor**, paste the whole of
   `db/schema.sql`, and Run. You should end up with two tables, `foods` and
   `log_entries`.

## 2. Move your existing data across

You have 17 days and 151 entries in `data/log.json`. Do not lose them:

Add the connection string to your local `.env` (it is gitignored):

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
```

No quotes, no spaces around the `=`, all on one line. Then:

```
cd ~/Projects/health-agent
npm run migrate
```

(`npm run migrate` reads `.env`. Do not use `VAR=value command` — that is bash
syntax and fish rejects it.)

Expect:

```
foods upserted : 59
entries added  : 151  (skipped 0 already present)
database now   : 151 entries, 35673 kcal total
```

**Check that number matches your local total.** Re-running is safe — entries
carry their existing id, so a second run inserts nothing.

## 3. GitHub

```
git remote add origin https://github.com/<you>/health-agent.git
git push -u origin main
```

The password prompt wants your **PAT**, not your account password.

## 4. Render — the app

1. **render.com** → New → **Web Service** → connect the repo.
2. Render reads `render.yaml`, so runtime, build and start commands are set
   already (`npm install`, `npm start`, Node).
3. Set four environment variables:

   | name | value |
   |---|---|
   | `GEMINI_API_KEY` | your key from the separate Google account |
   | `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
   | `DATABASE_URL` | the Neon **pooled** string from step 1 |
   | `APP_PASSCODE` | any phrase you will remember |

   > `APP_PASSCODE` is **not optional in production**. Without it the URL is
   > open to anyone who finds it — they could read your log and spend your
   > Gemini quota. When it is unset the app assumes local dev and lets
   > everything through.

4. Deploy. The log should end with `listening on 10000 (store: postgres)`.
   **If it says `store: json`, `DATABASE_URL` did not reach the app** — the
   app is running on an empty filesystem that Render wipes on every deploy.

## 5. Phone

Open the URL in Chrome → menu → **Add to home screen**. Enter the passcode
once; it is kept in `localStorage`.

---

## known free-tier behaviour

**Render free spins down after ~15 minutes idle.** The first request after a
cold start takes 30–60 seconds, which for a tracker you open three times a day
means most opens are slow. Options: accept it, keep it awake with a cron ping,
or pay for the always-on tier. Nothing in the app can fix this.

**Neon free has no such issue** for this size of data.

## checking it worked

- `/api/day` returns your real totals → Neon is connected
- log a meal you have eaten before → one tool call, under a second
- the Week and Stats tabs show all 17 days
- open it in a private window → it should ask for the passcode

## if something breaks

- **`store: json` in the logs** — `DATABASE_URL` is not set on Render.
- **`self signed certificate` / TLS errors** — you used the direct connection
  string instead of the pooled one.
- **401 on every request** — the passcode in your browser's `localStorage`
  does not match `APP_PASSCODE`. Clear site data and re-enter it.
- **429 from Gemini** — free tier. `gemini-3.5-flash-lite` has room;
  `gemini-3.6-flash` is capped at 20 requests **per day**.
