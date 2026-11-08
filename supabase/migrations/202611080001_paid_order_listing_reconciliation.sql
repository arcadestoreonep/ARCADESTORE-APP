-- A successful Flutterwave verification is the source of truth for a sale.
-- Keep paid-order settlement idempotent and repair listing/reservation state
-- whenever a duplicate webhook or payment reconciliation reaches this RPC.
create or replace function public.apply_payment_result(p_order uuid,p_tx jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  o public.orders%rowtype;
  i record;
  txid text;
begin
  select * into o from public.orders where id=p_order for update;
  if not found then
    return jsonb_build_object('ok',false,'reason','not_found');
  end if;

  -- Repair sale state even when the order was marked paid by an earlier
  -- deployment that failed to update all related rows.
  if o.status='paid' then
    update public.listings l
    set status='sold',updated_at=now()
    from public.order_items i
    where i.order_id=o.id and l.id=i.listing_id and l.status<>'sold';
    update public.reservations
    set status='completed'
    where order_id=o.id and status='checkout';
    return jsonb_build_object('ok',true,'duplicate',true);
  end if;

  if coalesce(p_tx->>'status','')<>'successful' then
    return jsonb_build_object('ok',false,'reason','not_successful');
  end if;
  if coalesce(p_tx->>'tx_ref','')<>o.flw_tx_ref
    or coalesce(p_tx->>'currency','')<>'NGN'
    or coalesce((p_tx->>'amount')::numeric,0)<>o.amount then
    return jsonb_build_object('ok',false,'reason','mismatch');
  end if;

  txid:=p_tx->>'id';
  if o.status<>'held' or o.hold_until<=now() then
    update public.orders
    set status='needs_refund',flw_transaction_id=txid,
        refund_reason='Payment arrived after the 20-minute hold expired'
    where id=o.id;
    return jsonb_build_object('ok',false,'reason','needs_refund');
  end if;

  update public.orders
  set status='paid',flw_transaction_id=txid,paid_at=now()
  where id=o.id;
  update public.listings l
  set status='sold',updated_at=now()
  from public.order_items i
  where i.order_id=o.id and l.id=i.listing_id and l.status<>'sold';
  update public.reservations
  set status='completed'
  where order_id=o.id and status='checkout';

  for i in select * from public.order_items where order_id=o.id loop
    insert into public.ledger(user_id,direction,amount,entry_type,order_id,reference)
    values(i.seller_id,'credit',i.net,'sale',o.id,'sale:'||o.id::text||':'||i.listing_id::text)
    on conflict(reference) do nothing;
  end loop;
  return jsonb_build_object('ok',true,'duplicate',false);
end;
$$;
