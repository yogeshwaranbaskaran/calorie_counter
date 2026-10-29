# deploy

Render for the app, any managed Postgres for the data. About 30 minutes, most
of it in Google Cloud Console.

The app runs without either: leave `DATABASE_URL` empty and it stores JSON
files in `data/`. That is fine locally and wrong in production, because
Render wipes the filesystem on every deploy.

## 1. the database

Create a Postgres database (Supabase, Neon and Render Postgres all work) in a
region near your users, and copy the **pooled** connection string. On Supabase
that is the session pooler, port 5432; on Neon it is the host containing
`-pooler`. A free-tier server with a small connection pool should not open
direct connections.

Then run the migrations, in order, in the provider's SQL editor or with
`npm run db:migrate`:

    db/001_schema.sql    foods, log_entries
    db/002_users.sql     accounts, per-user scoping, encrypted keys
    db/003_weight_targets_meals.sql
    db/004_food_library.sql
    db/005_fibre.sql

Load the USDA library once the tables exist:

    npm run library:load

## 2. Google sign-in

Skip this and the app stays single-user behind `APP_PASSCODE`.

Google Cloud Console, APIs & Services, Credentials, Create credentials, OAuth
client ID, Web application. Add both redirect URIs:

    http://localhost:3000/api/auth/callback
    https://<your-app>.onrender.com/api/auth/callback

Then publish the consent screen. Leaving it in Testing means only the test
users you listed can sign in.

## 3. Render

New, Web Service, connect the repo. Render reads `render.yaml`, so the
runtime, region, build command and health check path are already set. Fill in
the variables marked `sync: false`:

| variable | what it is |
|---|---|
| `DATABASE_URL` | the pooled connection string from step 1 |
| `GEMINI_API_KEY` | the key the owner account uses |
| `GOOGLE_CLIENT_ID` | from step 2 |
| `GOOGLE_CLIENT_SECRET` | from step 2 |
| `SESSION_SECRET` | 32 random bytes, see below |
| `OWNER_EMAIL` | the Google account that adopts pre-accounts rows |
| `APP_PASSCODE` | only used when Google sign-in is not configured |
| `API_TOKEN` | optional. Lets a script act as the owner, `Authorization: Bearer ...` |

    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

`SESSION_SECRET` signs session cookies **and** encrypts users' stored Gemini
keys. Changing it later signs everyone out and makes every stored key
unreadable, so each user would have to paste theirs again.

Put the Render service in the same region as the database. Across an ocean
every query costs about 180ms instead of about 2ms, and a page that runs three
of them takes seconds. Render cannot move a service between regions, so
getting this wrong means a new service and a new URL.

## 4. check it

    /api/health   ->  {"ok":true,"store":"postgres"}

Needs no passcode. `"store":"json"` means `DATABASE_URL` did not reach the
app, and it is writing to a disk that will be wiped. A 503 means the app is up
but cannot reach the database, and the message says why.

Then open the app, sign in as `OWNER_EMAIL` first so that account claims any
existing history, and log one meal you have logged before. It should come back
in under a second, from the table, without reaching the model.

## known free-tier behaviour

- Render free spins down after about 15 minutes idle; the next request takes
  30 to 60 seconds. A cron ping on `/api/health` keeps it warm, at the cost of
  instance hours. Check the monthly allowance before pinging around the clock.
- Gemini free tier limits vary per model by a lot. `gemini-3.5-flash-lite`
  has room; some flash models are capped at 20 requests per **day**.
- On a database billed by compute hour, an idle connection is not free. See
  the pool settings and the comment in `src/store.js`.

## when it breaks

| symptom | cause |
|---|---|
| `store: json` in the Render logs | `DATABASE_URL` is not set on the service |
| self-signed certificate errors | direct connection string instead of the pooled one |
| 401 on every request | browser passcode does not match `APP_PASSCODE` |
| bounced back to the key screen after saving a key | `SESSION_SECRET` changed, so the stored key no longer decrypts |
| 429 from Gemini | free-tier quota, check the per-model daily limit |
