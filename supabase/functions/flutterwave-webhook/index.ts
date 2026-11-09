import {sendPush} from '../_shared/push.ts';
import {flwRequest,json,service,env} from '../_shared/server.ts';
import {validateFlutterwaveKey} from '../_shared/core.mjs';
import {webhookRequestStatus} from '../_shared/webhook.mjs';

Deno.serve(async req=>{
 if(req.method!=='POST')return json({error:'method not allowed'},405);
 try{
  const expected=env('FLW_SECRET_HASH');
  const supplied=req.headers.get('verif-hash')||'';
  const event=await req.json().catch(()=>null);
  const gate=webhookRequestStatus(expected,supplied,event);
  if(gate===401)return json({error:'invalid webhook signature'},401);
  if(gate!==200)return json({error:'unsupported webhook event'},400);

  const db=service();
  const {data:order,error}=await db.from('orders').select('id,buyer_id,amount,status,flw_tx_ref,hold_until').eq('flw_tx_ref',String(event.data.tx_ref)).maybeSingle();
  if(error)throw new Error('Could not find the matching order');
  if(!order)return json({received:true,matched:false});
  if(order.status==='paid'){const {error:repairError}=await db.rpc('apply_payment_result',{p_order:order.id,p_tx:{}});if(repairError)throw new Error('Could not reconcile the confirmed sale');return json({received:true,status:'paid',duplicate:true});}
  if(order.status==='refunded')return json({received:true,status:order.status,duplicate:false});

  const rawMode=Deno.env.get('FLW_MODE')||'test';
  const secret=env(String(rawMode).toLowerCase()==='live'?'FLW_LIVE_SECRET_KEY':'FLW_TEST_SECRET_KEY');
  validateFlutterwaveKey(rawMode,secret);
  const verified=await flwRequest(secret,`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(order.flw_tx_ref)}`);
  const verifiedStatus=String(verified?.status||'').toLowerCase();
  if(['failed','cancelled','canceled'].includes(verifiedStatus)){
   const {data:cancelled,error:cancelError}=await db.rpc('cancel_checkout',{p_buyer:order.buyer_id,p_order:order.id});
   if(cancelError)throw new Error('Could not record the cancelled payment');
   return json({received:true,status:cancelled?'cancelled':order.status});
  }
  if(verifiedStatus!=='successful')return json({received:true,status:'pending'});
  const {data:result,error:applyError}=await db.rpc('apply_payment_result',{p_order:order.id,p_tx:verified});
  if(applyError)throw new Error('Could not settle the verified payment');
  if(result?.ok&&!result?.duplicate)await sendPush({event_type:'payment_confirmed',order_id:order.id});
  return json({received:true,...result});
 }catch(error){
  const message=String((error as Error)?.message||'webhook processing failed');
  console.error('Flutterwave webhook processing failed:',message);
  return json({error:'webhook processing failed'},500);
 }
});
