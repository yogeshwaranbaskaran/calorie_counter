# deploy

Four steps. Everything here needs a browser, so it is yours to do — the code
side is finished.

## 1. Supabase (storage)

New project → **SQL Editor** → paste all of `supabase/schema.sql` → Run.

Then **Settings → API** and copy two values:
- Project URL → `SUPABASE_URL`
- `service_role` key → `SUPABASE_SERVICE_KEY`

> The service_role key bypasses RLS. It is read **only** inside `api/`, which
> runs on the server. It must never appear in `public/`, and never be prefixed
> `VITE_` in any project — that is exactly how the splitter key leaked.

## 2. GitHub

    git remote add origin https://github.com/<you>/health-agent.git
    git push -u origin main

Password is your PAT, not your account password.

## 3. Vercel

Import the repo. No build step, no framework preset — `public/` is served
static and `api/*.js` become Node functions automatically.

Set five environment variables:

| name | value |
|---|---|
| `GEMINI_API_KEY` | the 39-char `AIzaSy…` key from the new account |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `SUPABASE_URL` | from step 1 |
| `SUPABASE_SERVICE_KEY` | from step 1 |
| `APP_PASSCODE` | any phrase you'll remember |

> `APP_PASSCODE` is not optional in production. Without it the URL is open to
> anyone who finds it — they could read your log and spend your Gemini quota.
> When it is unset the app assumes local dev and lets everything through.

## 4. Phone

Open the URL in Chrome → menu → **Add to home screen**. It installs as a
standalone app; the service worker caches the shell so it opens instantly.

Enter the passcode once — it's kept in `localStorage`.

## checking it worked

- `/api/day` returns `{"date":…,"totals":{"kcal":0…}}` → Supabase is connected
- type `2 dosa and sambar` → you should see `lookup_food → save_food → log_meal`
- log the same meal tomorrow → `save_food` should be gone. That's the cache.
