-- Family Rhythm update: only the PIN holder can change the photo PIN, and reward photos
-- come from weigh-ins, completed chores and paid bills (one photo per event).
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.

-- 1. Changing the PIN needs the current PIN (wrong guesses count toward the 15-minute lockout).
--    Returns 'ok', 'wrong', 'locked_out' or 'invalid'.
drop function if exists public.set_photo_pin(text);
create or replace function public.set_photo_pin(new_pin text, current_pin text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare has_pin boolean; result text;
begin
  if auth.uid() is null then return 'invalid'; end if;
  if coalesce(new_pin, '') !~ '^[0-9]{4,8}$' then return 'invalid'; end if;
  select pin_hash is not null into has_pin from public.photo_lock where owner = auth.uid();
  if coalesce(has_pin, false) then
    result := public.unlock_photos(current_pin);
    if result <> 'ok' then return result; end if;
  end if;
  insert into public.photo_lock (owner, pin_hash, unlocked_until)
  values (auth.uid(), extensions.crypt(new_pin, extensions.gen_salt('bf')), now() + interval '15 minutes')
  on conflict (owner) do update
    set pin_hash = excluded.pin_hash, unlocked_until = excluded.unlocked_until, failed_attempts = 0, locked_out_until = null;
  return 'ok';
end $$;

-- 2. The database stamps when a chore was finished and when a bill payment was recorded.
create or replace function public.stamp_chore_done() returns trigger language plpgsql as $$
begin
  if new.done and (tg_op = 'INSERT' or not coalesce(old.done, false)) then new.done_at := now();
  elsif not new.done then new.done_at := null;
  elsif tg_op = 'UPDATE' then new.done_at := old.done_at;
  end if;
  return new;
end $$;
drop trigger if exists chores_stamp_done on public.chores;
create trigger chores_stamp_done before insert or update on public.chores
  for each row execute function public.stamp_chore_done();

create or replace function public.stamp_created_at() returns trigger language plpgsql as $$
begin new.created_at := now(); return new; end $$;
drop trigger if exists bill_payments_stamp on public.bill_payments;
create trigger bill_payments_stamp before insert on public.bill_payments
  for each row execute function public.stamp_created_at();

-- pay_bill now returns the new payment's id, so the app can ask for its reward.
drop function if exists public.pay_bill(uuid, numeric, date, uuid);
create or replace function public.pay_bill(bill uuid, amount numeric, paid_on date, paid_by uuid) returns uuid
language plpgsql set search_path = '' as $$
declare b public.bills; new_id uuid;
begin
  select * into b from public.bills where id = pay_bill.bill for update;
  if not found then raise exception 'Bill not found'; end if;
  insert into public.bill_payments (owner, bill_id, due_date, paid_on, amount, paid_by)
  values (b.owner, b.id, b.next_due, coalesce(pay_bill.paid_on, current_date), pay_bill.amount, pay_bill.paid_by)
  returning id into new_id;
  update public.bills
    set next_due = public.next_due_after(b.next_due, b.frequency, b.due_day),
        active = b.frequency <> 'once',
        last_reminded_for = null
    where id = b.id;
  return new_id;
end $$;
grant execute on function public.pay_bill(uuid, numeric, date, uuid) to authenticated;

-- 3. One reward photo per weigh-in, finished chore or bill payment, claimed within 10 minutes.
create table if not exists public.reward_claims (
  owner uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('weigh_in', 'chore', 'bill')),
  event_id uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (owner, kind, event_id)
);
alter table public.reward_claims enable row level security; -- no policies: functions only

drop function if exists public.grant_reward();
create or replace function public.grant_reward(kind text, event uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare pick text; fresh boolean; claimed int;
begin
  fresh := case grant_reward.kind
    when 'weigh_in' then exists (select 1 from public.weigh_ins w where w.id = event and w.owner = auth.uid() and w.saved_at > now() - interval '10 minutes')
    when 'chore' then exists (select 1 from public.chores c where c.id = event and c.owner = auth.uid() and c.done and c.done_at > now() - interval '10 minutes')
    when 'bill' then exists (select 1 from public.bill_payments p where p.id = event and p.owner = auth.uid() and p.created_at > now() - interval '10 minutes')
    else false end;
  if not fresh then return null; end if;

  insert into public.reward_claims (owner, kind, event_id) values (auth.uid(), grant_reward.kind, event)
    on conflict do nothing;
  get diagnostics claimed = row_count;
  if claimed = 0 then return null; end if;

  select o.name into pick from storage.objects o
    where o.bucket_id = 'photos' and (storage.foldername(o.name))[1] = auth.uid()::text and o.name not like '%/.%'
    order by random() limit 1;
  if pick is null then return null; end if;
  delete from public.reward_grants where owner = auth.uid() and expires_at < now();
  insert into public.reward_grants (owner, object_name, expires_at) values (auth.uid(), pick, now() + interval '2 minutes')
    on conflict (owner, object_name) do update set expires_at = excluded.expires_at;
  return pick;
end $$;

revoke execute on function public.set_photo_pin(text, text), public.grant_reward(text, uuid) from public, anon;
grant execute on function public.set_photo_pin(text, text), public.grant_reward(text, uuid) to authenticated;
