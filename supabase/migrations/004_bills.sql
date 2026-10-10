-- Family Rhythm update: shared bills with reminders, payment links and payment history.
-- Paste this whole file into Supabase: SQL Editor > New query > Run. Safe to run more than once.

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  amount numeric(10,2) check (amount >= 0),               -- the usual amount; optional
  frequency text not null default 'monthly'
    check (frequency in ('once', 'weekly', 'biweekly', 'monthly', 'yearly')),
  next_due date not null,
  due_day smallint check (due_day between 1 and 31),       -- monthly bills keep this day, even after short months
  pay_url text check (pay_url ~* '^https?://' and char_length(pay_url) <= 500),
  remind_days smallint default 3 check (remind_days between 0 and 30), -- days before due; null = no reminder
  remind_hour smallint not null default 9 check (remind_hour between 0 and 23), -- New York time
  last_reminded_for date,                                   -- the due date we last reminded about
  active boolean not null default true,                     -- one-time bills go inactive once paid
  created_at timestamptz not null default now()
);

create table if not exists public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  bill_id uuid not null references public.bills on delete cascade,
  due_date date not null,
  paid_on date not null default current_date,
  amount numeric(10,2) check (amount >= 0),
  paid_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists bills_owner_due on public.bills (owner, next_due);
create index if not exists bill_payments_owner_paid on public.bill_payments (owner, paid_on desc);

alter table public.bills enable row level security;
alter table public.bill_payments enable row level security;
drop policy if exists "household only" on public.bills;
drop policy if exists "household only" on public.bill_payments;
create policy "household only" on public.bills for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy "household only" on public.bill_payments for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

grant select, insert, update, delete on public.bills, public.bill_payments to authenticated, service_role;

-- The due date after d. Monthly bills land on due_day, or the month's last day if it's shorter.
create or replace function public.next_due_after(d date, frequency text, due_day smallint) returns date
language sql immutable set search_path = '' as $$
  select case frequency
    when 'weekly' then d + 7
    when 'biweekly' then d + 14
    when 'monthly' then (date_trunc('month', d) + interval '1 month')::date
      + (least(coalesce(due_day, extract(day from d)::int),
               extract(day from date_trunc('month', d) + interval '2 months' - interval '1 day')::int) - 1)
    when 'yearly' then (d + interval '1 year')::date
    else d
  end;
$$;

-- Record a payment and roll the bill to its next due date, in one step.
-- Runs as the signed-in user, so Row Level Security still applies.
create or replace function public.pay_bill(bill uuid, amount numeric, paid_on date, paid_by uuid) returns void
language plpgsql set search_path = '' as $$
declare b public.bills;
begin
  select * into b from public.bills where id = pay_bill.bill for update;
  if not found then raise exception 'Bill not found'; end if;
  insert into public.bill_payments (owner, bill_id, due_date, paid_on, amount, paid_by)
  values (b.owner, b.id, b.next_due, coalesce(pay_bill.paid_on, current_date), pay_bill.amount, pay_bill.paid_by);
  update public.bills
    set next_due = public.next_due_after(b.next_due, b.frequency, b.due_day),
        active = b.frequency <> 'once',
        last_reminded_for = null
    where id = b.id;
end $$;

-- Undo a bill's most recent payment and put the bill back on that due date.
create or replace function public.undo_bill_payment(payment uuid) returns void
language plpgsql set search_path = '' as $$
declare p public.bill_payments;
begin
  select * into p from public.bill_payments where id = undo_bill_payment.payment;
  if not found then raise exception 'Payment not found'; end if;
  if exists (select 1 from public.bill_payments x where x.bill_id = p.bill_id and x.created_at > p.created_at) then
    raise exception 'Only the most recent payment for a bill can be undone';
  end if;
  delete from public.bill_payments where id = p.id;
  update public.bills set next_due = p.due_date, active = true, last_reminded_for = null where id = p.bill_id;
end $$;

grant execute on function public.next_due_after(date, text, smallint), public.pay_bill(uuid, numeric, date, uuid),
  public.undo_bill_payment(uuid) to authenticated;
