-- Fibre. The USDA library has carried it since day one, but it was never
-- plumbed into a user's own foods or their log, so the one macro the user was
-- actually short on was invisible.
alter table foods       add column if not exists fiber_g numeric not null default 0;
alter table log_entries add column if not exists fiber_g numeric;
alter table users       add column if not exists target_fiber_g numeric;
