-- Multi-user migration. Safe to run on the live database with data in it:
-- existing rows get user_id NULL and are adopted by the owner on first login
-- (see adoptOrphans in src/auth.js).

create table if not exists users (
  id           bigserial primary key,
  google_sub   text unique not null,      -- Google's stable subject id
  email        text not null,
  name         text,
  picture      text,
  -- 'byok'   : the user supplies their own Gemini key, free
  -- 'hosted' : they use the owner's key, which is what a subscription buys
  plan         text not null default 'byok',
  gemini_key   text,                      -- AES-256-GCM ciphertext, never plaintext
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table foods       add column if not exists user_id bigint references users(id) on delete cascade;
alter table log_entries add column if not exists user_id bigint references users(id) on delete cascade;

-- A food name is unique PER USER: "dosa" means your dosa, learned from your
-- corrections, and must never collide with someone else's.
alter table foods drop constraint if exists foods_pkey;
alter table foods add column if not exists id bigserial;
create unique index if not exists foods_user_name_idx on foods (user_id, name);

create index if not exists log_entries_user_date_idx on log_entries (user_id, date);
