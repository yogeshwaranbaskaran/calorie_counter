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
   `db/001_schema.sql`, and Run. You should end up with two tables, `foods` and
   `log_entries`.

## 2. Move your existing data across

You have 17 days and 151 entries in `data/log.json`. Do not lose them:

Add the connection string to your local `.env` (it is gitignored):

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
```

No quotes, no spaces around the `=`, all on one line. Then:

```
cd ~/Projects/calorie_counter
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
git remote add origin https://github.com/<you>/calorie_counter.git
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

5. Check `https://<your-app>.onrender.com/api/health` — it needs no passcode
   and answers `{"ok":true,"store":"postgres"}`. A 503 means the app is up but
   cannot reach Neon, and the message says why.

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


---

# adding accounts (Google sign-in)

Until these are set the app stays single-user behind `APP_PASSCODE`. Setting
them turns on accounts, and every row is scoped to its owner.

## 1. Google Cloud Console

APIs & Services → **Credentials** → Create credentials → **OAuth client ID** →
**Web application**. Authorised redirect URIs — add both:

```
http://localhost:3000/api/auth/callback
https://calorie-counter-pedb.onrender.com/api/auth/callback
```

Then **OAuth consent screen → Publish**. Leaving it in Testing means only
listed test users can sign in — the exact thing that blocked Smart Splitter.

Keep the **Client ID** and **Client secret**.

## 2. Migrate the live database FIRST

Run `db/002_users.sql` in the Neon SQL Editor **before** deploying the new
code, or the app will query columns that do not exist yet.

It is safe on data: existing rows get `user_id NULL` and are adopted by
`OWNER_EMAIL` the first time you sign in.

## 3. Four more environment variables on Render

| name | value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 1 |
| `GOOGLE_CLIENT_SECRET` | from step 1 |
| `SESSION_SECRET` | 32 random bytes — see below |
| `OWNER_EMAIL` | your Google account email |

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> `SESSION_SECRET` signs session cookies **and** encrypts users' stored Gemini
> keys. Changing it later signs everyone out and makes stored keys unreadable —
> they would each have to paste theirs again.

## 3b. Optional: a token for your own scripts

`API_TOKEN` lets a script act as the `OWNER_EMAIL` account without a browser
session — the local Suno agent uses it. Send it as `Authorization: Bearer …`.
Generate one the same way as `SESSION_SECRET`; it can be rotated freely.

## 4. Sign in

Deploy, open the app, **Continue with Google**. Sign in with `OWNER_EMAIL`
first: that account claims your existing history. Then pick a plan — you'll
want **use my own key** with the key already in your `.env`.

Anyone else who signs in starts empty, with their own food table.

## what each plan means

- **own key (free)** — they paste a Gemini key from AI Studio. Stored
  encrypted, never shown back. Their quota, not yours.
- **app's key (subscription)** — uses `GEMINI_API_KEY`. Works today and shows
  a notice that payment is coming; it is not yet a hard stop.


---

# weight, targets and meals (migration 003)

Run `db/003_weight_targets_meals.sql` in the Neon SQL Editor **before**
deploying. It adds the `weights` table, `meal` on entries and target columns
on users. Safe on live data; nothing existing changes.

No new environment variables.

---

# speed: put Render next to the database

Measured 2026-09-21: phone in Tokyo, Render in **San Francisco**, Neon in
**Singapore**. Every API call crossed the Pacific twice and ran three
sequential ~180ms queries. Navigation took 2-3 seconds.

Code-side fixes (warm connections, cached user, cached days) roughly halve
it. The rest is geography, and the fix is to create the Render service in
**Singapore** so it sits beside Neon (~2ms per query instead of ~180ms).

Render cannot move an existing service between regions, so this is a new
service with a new URL:

1. Render → New → Web Service → connect the repo → **Region: Singapore**
2. Copy every environment variable from the old service (Environment tab)
3. Deploy; note the new `https://calorie-counter-XXXX.onrender.com`
4. Google Cloud → Credentials → the OAuth client → add the new callback URI
   `https://<new-host>/api/auth/callback`; Branding → update home page,
   privacy URL, authorized domain
5. Re-point the keep-alive ping (cron-job.org) at the new `/api/health`
6. Delete the old service; re-add the app to your phone's home screen

Nothing in the database changes. Sessions carry over because SESSION_SECRET
is the same.
