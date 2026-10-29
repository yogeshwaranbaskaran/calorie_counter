# what is not built, and why

v1 shipped 2026-09-21. In daily use since; the list below is what has been
deliberately left alone.

## before this goes past a handful of users

- **Hosted plan hard stop.** `plan = 'hosted'` currently works and shows a
  notice saying payment is coming. It is not a gate. Once there is a way to
  pay, `/api/chat` has to check a paid flag before spending the owner's key.
- **Per-user daily cap** on the owner's key, so one account cannot drain the
  free-tier quota for everyone on it.
- **Google brand verification**, to remove the "Google hasn't verified this
  app" warning on first sign-in. Needs domain ownership in Search Console.
  Cosmetic, and the warning is honest: it is a private app, not a company.

## worth doing, not urgent

- **More nutrition data in the library.** USDA FoodData Central (CC0, bulk
  CSV) is already in; Open Food Facts would add barcodes. Both are weak on
  Indian home cooking, which is exactly where the model's estimate is
  competitive, so this buys less than it looks like it would.
- **Nutrition-label scanning.** Was in the v1 spec, never built. The same
  vision call that reads a label reads a restaurant bill.
- **Timezone per user.** `src/agent.js` tells the model the *server's* date,
  and `inferMeal` in `src/tools.js` reads the server's clock hour to guess
  breakfast from dinner. Both are correct for a server in the user's own
  timezone and wrong by several hours for anyone else. The server date is
  pinned in `render.yaml` today, which is a workaround, not a fix.

## known behaviour, not bugs

- Render free sleeps after 15 minutes idle, so the first open of the day is
  slow. See the note in `DEPLOY.md`.
- Estimates for cooked dishes are a model's guess. The app shows what it
  assumed and lets you correct it, which is the honest version of the
  feature, but it is still a guess until you correct it.
