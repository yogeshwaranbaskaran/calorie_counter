-- Shared reference library, per 100g. Read by every user, written by nobody
-- through the app: corrections always go to the user's own foods table.
-- Loaded from data/usda.json with `npm run library:load`.
create table if not exists food_library (
  id        bigserial primary key,
  source    text    not null,            -- usda_sr_legacy | usda_foundation
  fdc_id    integer,
  name      text    not null,
  category  text,
  kcal      numeric not null,
  protein_g numeric not null,
  carbs_g   numeric not null,
  fat_g     numeric not null,
  sugar_g   numeric not null,
  fiber_g   numeric
);
create unique index if not exists food_library_source_fdc_idx on food_library (source, fdc_id);
-- Word search: every query word must appear in the name. Trigram index makes
-- ILIKE '%word%' fast enough over ~8k rows to not matter.
create extension if not exists pg_trgm;
create index if not exists food_library_name_trgm on food_library using gin (name gin_trgm_ops);
