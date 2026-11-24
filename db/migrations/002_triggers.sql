-- updated_at maintenance + immutability guards for financial and audit records.

do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    where c.table_schema = current_schema() and c.column_name = 'updated_at'
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

create or replace function forbid_change() returns trigger language plpgsql as
$$
begin
  raise exception 'Records in % are permanent and cannot be % (use a refund or reversal record instead)',
    tg_table_name, lower(tg_op) || 'd' using errcode = 'P0001';
end $$;

-- Append-only ledgers: never updated, never deleted.
create trigger transaction_items_immutable before update or delete on transaction_items for each row execute function forbid_change();
create trigger refunds_immutable before update or delete on refunds for each row execute function forbid_change();
create trigger payments_immutable before update or delete on payments for each row execute function forbid_change();
create trigger inventory_movements_immutable before update or delete on inventory_movements for each row execute function forbid_change();
create trigger discount_usage_immutable before update or delete on discount_usage for each row execute function forbid_change();
create trigger audit_logs_immutable before update or delete on audit_logs for each row execute function forbid_change();

-- Transactions can never be deleted; only settlement fields (payments received, refund totals, status) may change.
create trigger transactions_no_delete before delete on transactions for each row execute function forbid_change();

create or replace function guard_transaction_update() returns trigger language plpgsql as
$$
begin
  if new.transaction_no is distinct from old.transaction_no
     or new.transaction_type is distinct from old.transaction_type
     or new.subtotal is distinct from old.subtotal
     or new.discount_total is distinct from old.discount_total
     or new.total is distinct from old.total
     or new.vat_amount is distinct from old.vat_amount
     or new.cashier_id is distinct from old.cashier_id
     or new.player_id is distinct from old.player_id
     or new.customer_name is distinct from old.customer_name
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'Completed financial transactions cannot be modified' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger transactions_guard before update on transactions for each row execute function guard_transaction_update();

-- A closed shift is final.
create or replace function guard_shift_update() returns trigger language plpgsql as
$$
begin
  if old.status = 'closed' then
    raise exception 'Closed cashier shifts cannot be modified' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger cashier_shifts_guard before update or delete on cashier_shifts for each row execute function guard_shift_update();
