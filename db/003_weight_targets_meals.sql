-- Weight log, per-user targets, and which meal an entry belongs to.
-- Safe on live data: new table, new nullable column, new columns with defaults.

create table if not exists weights (
  id         bigserial primary key,
  user_id    bigint references users(id) on delete cascade,
  date       date    not null,
  kg         numeric not null,
  created_at timestamptz not null default now()
);
-- One weight per day per user; logging again the same day replaces it.
create unique index if not exists weights_user_date_idx on weights (user_id, date);

-- Which meal. Inferred by the agent from the words ("lunch was...") or, when
-- logging today, from the time of day. NULL for older rows.
alter table log_entries add column if not exists meal text
  check (meal in ('breakfast','lunch','dinner','snack'));

-- Daily targets. NULL means "not set" and the UI shows the average instead.
alter table users add column if not exists target_kcal      numeric;
alter table users add column if not exists target_protein_g numeric;
alter table users add column if not exists target_carbs_g   numeric;
alter table users add column if not exists target_fat_g     numeric;
alter table users add column if not exists target_sugar_g   numeric;
alter table users add column if not exists goal_kg          numeric;
alter table users add column if not exists height_cm        numeric;
