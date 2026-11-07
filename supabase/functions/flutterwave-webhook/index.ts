import {flwRequest,json,service,env} from '../_shared/server.ts';
import {validateFlutterwaveKey} from '../_shared/core.mjs';

function equalSecret(a:string,b:string){
 const left=new TextEncoder().encode(a),right=new TextEncoder().encode(b);
 if(left.length!==right.length)return false;
 let diff=0;for(let i=0;i<left.length;i++)diff|=left[i]^right[i];
 return diff===0;
}

Deno.serve(async req=>{
 if(req.method!=='POST')return json({error:'method not allowed'},405);
 try{
  const expected=env('FLW_WEBHOOK_SECRET_HASH');
  const supplied=req.headers.get('verif-hash')||'';
  if(!equalSecret(expected,supplied))return json({error:'invalid webhook signature'},401);
  const event=await req.json().catch(()=>null);
  if(!event||event.event!=='charge.completed'||!event.data?.tx_ref)return json({received:true});

  const db=service();
  const {data:order,error}=await db.from('orders').select('id,buyer_id,amount,status,flw_tx_ref,hold_until').eq('flw_tx_ref',String(event.data.tx_ref)).maybeSingle();
  if(error)throw new Error('Could not find the matching order');
  if(!order)return json({received:true,matched:false});
  if(['paid','cancelled','refunded'].includes(order.status))return json({received:true,status:order.status,duplicate:order.status==='paid'});

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
  return json({received:true,...result});
 }catch(error){
  const message=String((error as Error)?.message||'webhook processing failed');
  console.error('Flutterwave webhook processing failed:',message);
  return json({error:'webhook processing failed'},500);
 }
});
