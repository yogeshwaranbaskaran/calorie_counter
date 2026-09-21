# what's next

v1 shipped 2026-09-21 at https://calorie-counter-oit1.onrender.com
(Render Singapore + Neon ap-southeast-1). Paused here to return to other work.

## before inviting more than a few friends

- **Starter food library.** Every new account begins empty and spends a week
  teaching the agent. A shared library the agent falls back to when the
  personal table misses (personal first, library second, estimate last;
  corrections always write personal) fixes the cold start. Library rows =
  `user_id NULL` after a curated seed. ~1 hour.
- **Hosted plan hard stop.** `plan = 'hosted'` currently works and shows a
  notice. Once payments exist: gate `/api/chat` on a paid flag.
- **Per-user daily cap** on the owner's key, so one account cannot drain the
  free-tier quota for everyone.

## when there's appetite

- **Internet nutrition data** into the library: USDA FoodData Central (CC0,
  bulk CSV) for raw ingredients; Open Food Facts for barcodes. Both weak on
  Indian home cooking - the LLM estimate is competitive there.
- **Nutrition-label scanning** (was in the v1 spec, never built). Reuses the
  scan-bill vision pipeline from Smart Splitter.
- **Google brand verification** to remove the "unverified app" warning. Needs
  Search Console domain ownership + the keep-alive ping so Google's bot
  doesn't hit a sleeping server. Cosmetic.
- `/diag.html` can go; it was the input-bug debugger.

## known
- Render free sleeps after 15 min idle. cron-job.org pings `/api/health`
  every 10 min; if that lapses, first open takes 30-60s.
- Free Gemini tier: `gemini-3.5-flash-lite` has headroom; `gemini-3.6-flash`
  is 20 requests/DAY and will not work.
