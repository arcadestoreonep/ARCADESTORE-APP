import webpush from 'npm:web-push@3.6.7';
import {json,service,env} from '../_shared/server.ts';
import {pushCopy,pushRecipients,pushTarget} from '../_shared/push.mjs';
import {deliverWithRetryAndCleanup} from '../_shared/push-delivery.mjs';

// VAPID public key is public client configuration; its matching private key and
// subject are read only from Edge Function secrets.
const VAPID_PUBLIC_KEY='BC_s5RXbI2JEUNNjQwRWCmIqFaBdsX8jBuhvnI1RYqa6HBIN9YSb0QOEoG2YGhSO1RCJ-C3glC0j_FU56CsVz2Y';
webpush.setVapidDetails(env('VAPID_SUBJECT'),VAPID_PUBLIC_KEY,env('VAPID_PRIVATE_KEY'));
const encoder=new TextEncoder();
function constantTimeEqual(left:string,right:string){const a=encoder.encode(left),b=encoder.encode(right);let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a[i]||0)^(b[i]||0);return diff===0;}
function eventURL(orderId:string,chat=false,role='buyer',eventType='chat_message'){return `https://arcadestoreonep.github.io/ARCADESTORE-APP/${pushTarget(orderId,chat,role,eventType).replace(/^\.\//,'')}`;}
async function sendOne(subscription:any,payload:string){
  return deliverWithRetryAndCleanup(subscription,()=>webpush.sendNotification({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth}},payload,{TTL:3600,urgency:'normal'}),id=>service().from('push_subscriptions').delete().eq('id',id));
}
async function alreadyDelivered(db:any,key:string,userId:string){const {data,error}=await db.from('push_deliveries').select('event_key').eq('event_key',key).eq('user_id',userId).maybeSingle();if(error)throw new Error('push delivery status unavailable');return !!data;}
async function sendToUser(db:any,userId:string,key:string,eventType:string,order:any,item:any,chat=false){
  if(!userId||await alreadyDelivered(db,key,userId))return {sent:0,gone:0,failed:0};
  const {data:preferences}=await db.from('push_preferences').select(eventType).eq('user_id',userId).maybeSingle();if(preferences?.[eventType]===false)return {sent:0,gone:0,failed:0};
  const copy=pushCopy(eventType,order,item);if(!copy)return {sent:0,gone:0,failed:0};
  const {data:userData}=await db.auth.admin.getUserById(userId);const recipientRole=String(userData?.user?.app_metadata?.role||'buyer');
  const {data:subscriptions,error}=await db.from('push_subscriptions').select('id,endpoint,p256dh,auth').eq('user_id',userId);if(error)throw new Error('push subscriptions unavailable');
  let sent=0,gone=0,failed=0;
  for(const subscription of subscriptions||[]){const result=await sendOne(subscription,JSON.stringify({...copy,url:eventURL(order.id,chat||eventType==='assisted_delivery',recipientRole,eventType),tag:key}));if(result==='sent')sent++;else if(result==='gone')gone++;else failed++;}
  if(sent){const {error:logError}=await db.from('push_deliveries').insert({event_key:key,user_id:userId});if(logError&&logError.code!=='23505')throw new Error('push delivery could not be recorded');}
  return {sent,gone,failed};
}
async function loadOrder(db:any,id:string){const {data,error}=await db.from('orders').select('id,order_code,buyer_id,amount,status,order_items(id,listing_id,seller_id,owner_type,owner_vendor_id,delivery_type,gross,delivery_status,rental_expires_at,listing:listings(listing_code))').eq('id',id).maybeSingle();if(error||!data)throw new Error('order not found');return {...data,order_items:(data.order_items||[]).map((item:any)=>({...item,listing_code:item.listing?.listing_code||item.listing_id}))};}
async function dispatch(db:any,order:any,eventType:string,eventKey:string,actorId:string|null=null,item:any=null,supportThread=false){
  const recipients=pushRecipients(eventType,{...order,support_thread:supportThread},actorId,env('OWNER_USER_ID'));
  let total={sent:0,gone:0,failed:0};
  for(const userId of recipients){const result=await sendToUser(db,userId,eventKey,eventType,order,item,eventType==='chat_message');total.sent+=result.sent;total.gone+=result.gone;total.failed+=result.failed;}
  return total;
}
async function sweepRentals(db:any){
  const now=Date.now(),soon=new Date(now+24*60*60*1000).toISOString();
  const {data:items,error}=await db.from('order_items').select('id,order_id,listing_id,seller_id,owner_type,owner_vendor_id,delivery_type,gross,delivery_status,rental_expires_at,listing:listings(listing_code)').eq('delivery_type','rental').in('delivery_status',['rental_active','rental_expired']).not('rental_expires_at','is',null).lte('rental_expires_at',soon);
  if(error)throw new Error('could not inspect rental schedule');
  let events=0;
  for(const raw of items||[]){const order=await loadOrder(db,raw.order_id);if(order.status!=='paid')continue;const item={...raw,listing_code:raw.listing?.listing_code||raw.listing_id};const expired=new Date(raw.rental_expires_at).getTime()<=now;const type=expired?'rental_expired':'rental_expiring';const key=`${type}:${raw.id}:${raw.rental_expires_at}`;await dispatch(db,order,type,key,null,item);events++;}
  return events;
}

Deno.serve(async req=>{
  if(req.method!=='POST')return json({error:'method not allowed'},405);
  try{
    const supplied=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
    const cronToken=req.headers.get('x-arcade-push-token')||'';
    if(!constantTimeEqual(supplied,env('SUPABASE_SERVICE_ROLE_KEY'))&&!constantTimeEqual(cronToken,env('PUSH_CRON_TOKEN')))return json({error:'unauthorized'},401);
    const data=await req.json().catch(()=>({})),db=service();
    if(data.action==='rental_sweep')return json({ok:true,events:await sweepRentals(db)});
    const orderId=String(data.order_id||''),eventType=String(data.event_type||'');
    if(!orderId||!['payment_confirmed','chat_message'].includes(eventType))return json({error:'invalid push event'},400);
    const order=await loadOrder(db,orderId);if(order.status!=='paid')return json({ok:true,skipped:'order_not_paid'});
    if(eventType==='chat_message'){
      const actorId=String(data.actor_id||''),messageId=String(data.message_id||'');
      if(!actorId||!messageId)return json({error:'invalid message event'},400);
      const {data:thread}=await db.from('order_chats').select('buyer_id,vendor_id').eq('order_id',orderId).maybeSingle();
      const supportThread=actorId===env('OWNER_USER_ID')||!thread?.vendor_id;
      const item=order.order_items[0]||{};
      const result=await dispatch(db,order,'chat_message',`chat:${messageId}`,actorId,item,supportThread);
      return json({ok:true,...result});
    }
    let total={sent:0,gone:0,failed:0};
    for(const item of order.order_items){
      const type=item.delivery_type==='rental'?'rental_started':item.delivery_type==='assisted'?'assisted_delivery':'instant_sale';
      const result=await dispatch(db,order,type,`payment:${order.id}:${type}:${item.id}`,null,item);
      total.sent+=result.sent;total.gone+=result.gone;total.failed+=result.failed;
    }
    return json({ok:true,...total});
  }catch{console.error('[push] dispatch failed');return json({error:'push dispatch failed'},500);}
});
