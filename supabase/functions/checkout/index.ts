import {body,env,fail,featureMap,flwRequest,identity,json,service} from '../_shared/server.ts';
import {commissionPercentFromConfig,requireFeature,requireRole,resolveCheckoutRouting,validateFlutterwaveKey} from '../_shared/core.mjs';
import {flutterwavePaymentRequest} from '../_shared/operations.mjs';

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}});
 try{
  const {user}=await identity(req);requireRole(user,['buyer','vendor','admin','owner']);
  const db=service(),flags=await featureMap(db);requireFeature(flags,'checkout');
  const rawMode=Deno.env.get('FLW_MODE')||'test';
  const secret=env(String(rawMode).toLowerCase()==='live'?'FLW_LIVE_SECRET_KEY':'FLW_TEST_SECRET_KEY');
  const mode=validateFlutterwaveKey(rawMode,secret);
  if(mode==='live')requireFeature(flags,'live_payments');
  const commissionPercent=commissionPercentFromConfig(env('PLATFORM_COMMISSION_PERCENT'));
  const {error:holdError}=await db.rpc('expire_orders');if(holdError)throw new Error('Could not refresh payment attempts');
  const {error:reservationError}=await db.rpc('expire_reservations');if(reservationError)throw new Error('Could not refresh reservations');
  await db.rpc('expire_rentals');
  const txRef=`arcadestore-${crypto.randomUUID()}`;
  const {data:order,error}=await db.rpc('create_cart_order',{p_buyer:user.id,p_tx_ref:txRef,p_commission_percent:commissionPercent});
  if(error)throw new Error(error.message);
  try{
   const {data:items,error:itemError}=await db.from('order_items').select('gross,owner_type,owner_vendor_id,vendor_subaccount_id').eq('order_id',order.id);
   if(itemError||!items?.length)throw new Error('Could not determine order recipients');
   const routing=resolveCheckoutRouting(items,commissionPercent);
   const returnBase=env('SITE_URL',false)||'https://arcadestoreonep.github.io/ARCADESTORE-APP/';
   const returnUrl=new URL(returnBase);returnUrl.searchParams.set('payment_return','1');returnUrl.searchParams.set('order_id',order.id);
   const payload=flutterwavePaymentRequest({reference:txRef,amount:order.amount,redirectUrl:returnUrl.toString(),email:user.email||`user-${user.id}@example.invalid`,orderId:order.id,subaccounts:routing.subaccounts});
   const payment=await flwRequest(secret,'/payments',{method:'POST',body:JSON.stringify(payload)});
   if(!payment?.link?.startsWith('https://'))throw new Error('Flutterwave did not return a checkout link');
   const {data:attached,error:attachError}=await db.rpc('attach_checkout',{p_buyer:user.id,p_order:order.id,p_reference:txRef,p_url:payment.link});
   if(attachError||!attached)throw new Error('Could not attach checkout to the order');
   return json({order_id:order.id,order_code:order.order_code,checkout_url:payment.link,hold_until:order.hold_until,mode});
  }catch(error){
   await db.rpc('cancel_checkout',{p_buyer:user.id,p_order:order.id});
   const message=String((error as Error)?.message||'checkout unavailable').replace(secret,'[redacted]');
   throw new Error(`Could not start payment: ${message}`);
  }
 }catch(error){return fail(error);}
});
