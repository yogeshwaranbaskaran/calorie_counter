# what's next

v1 shipped 2026-09-21 at https://calorie-counter-oit1.onrender.com
(Render Singapore + Neon ap-southeast-1). Paused here to return to other work.

## before inviting more than a few friends

- ~~Starter food library~~ **DONE 2026-09-22**: `food_library` holds 8,061 USDA
  foods (SR Legacy + Foundation, per 100g, public domain). The agent calls
  `search_library` before estimating; corrections still write to the personal
  table. Refresh with `node src/usda-extract.js <csv dirs>` then
  `npm run library:load`. Still weak on Indian dishes - that stays estimated.
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
