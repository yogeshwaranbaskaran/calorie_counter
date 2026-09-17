-- Plain Postgres (Neon). Run once against your database:
--   psql "$DATABASE_URL" -f db/001_schema.sql

-- Foods are stored PER SINGLE UNIT. Quantity is applied at read time by code,
-- never by the model. For unit 'g'/'ml' the values are per 100, the way a
-- nutrition label states them.
create table if not exists foods (
  name            text primary key,          -- already normalized (lowercased)
  unit            text        not null,      -- piece, bowl, cup, glass, slice, g, ml
  grams_per_unit  numeric     not null,
  kcal            numeric     not null,
  protein_g       numeric     not null,
  carbs_g         numeric     not null,
  fat_g           numeric     not null,
  sugar_g         numeric     not null,
  confirmed_at    timestamptz not null default now()
);

create table if not exists log_entries (
  id         bigserial primary key,
  date       date    not null,               -- calendar day, local. never a timestamp.
  name       text    not null,
  qty        numeric not null,
  unit       text,
  grams      numeric,
  kcal       numeric not null,
  protein_g  numeric,
  carbs_g    numeric,
  fat_g      numeric,
  sugar_g    numeric,
  created_at timestamptz not null default now()
);

create index if not exists log_entries_date_idx on log_entries (date);
