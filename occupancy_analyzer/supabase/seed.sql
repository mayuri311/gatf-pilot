-- LOCAL / OFFLINE seed only (supabase db reset). The hosted project gets lots/cameras
-- from web/scripts/sync-config.ts (config/config.yaml) and its secrets set by hand.

insert into public.lots (lot_id, name, capacity, timezone, settings, config_synced_at)
values ('gatf_main', 'GATF Parking Lot', 100, 'America/New_York',
        '{"effective_pct": 0.85, "heartbeat_offline_s": 180}', now())
on conflict (lot_id) do nothing;

insert into public.lot_capacity_history (lot_id, capacity, valid_from)
values ('gatf_main', 100, '2026-01-01T00:00:00Z')
on conflict do nothing;

insert into public.cameras (camera_id, lot_id, direction, device_id) values
  ('inbound_cam_01',  'gatf_main', 'in',  'jetson-in-01'),
  ('outbound_cam_01', 'gatf_main', 'out', 'jetson-out-01')
on conflict (camera_id) do nothing;

-- local-only secrets
insert into private.app_secrets (name, value)
values ('plate_hmac_key', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (name) do nothing;

-- local-only password for the read-only chat role (hosted: ALTER ROLE ... PASSWORD by hand)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'gatf_readonly') then
    alter role gatf_readonly with login password 'gatf_readonly_local';
  end if;
end $$;
