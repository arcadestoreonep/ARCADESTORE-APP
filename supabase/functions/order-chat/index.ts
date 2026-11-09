import {sendPush} from '../_shared/push.ts';
import {body,env,fail,identity,json,service} from '../_shared/server.ts';
import {requireRole} from '../_shared/core.mjs';

async function permitted(db:any,user:any,orderId:string){
 const {data:order,error}=await db.from('orders').select('id,buyer_id,status,order_code,amount,flw_tx_ref,delivery_status,order_items(listing_id,seller_id,owner_vendor_id,delivery_type)').eq('id',orderId).maybeSingle();
 if(error||!order)throw new Error('order not found');
 if(order.status!=='paid')throw new Error('chat is available after payment is confirmed');
 const role=user.app_metadata?.role;
 const ok=order.buyer_id===user.id||role==='owner'||role==='vendor'&&order.order_items.some((i:any)=>i.owner_vendor_id===user.id);
 if(!ok)throw new Error('forbidden');
 if(!order.order_items.some((i:any)=>i.delivery_type==='assisted'||i.delivery_type==='rental'))throw new Error('this order does not use chat');
 return order;
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}});
 try{
  const {user}=await identity(req),role=requireRole(user,['buyer','vendor','admin','owner']),data=await body(req),db=service(),orderId=String(data.order_id||'');
  if(!orderId)throw new Error('order is required');
  const order=await permitted(db,user,orderId);
  if(data.action==='history'){
   const {data:messages,error}=await db.from('chat_messages').select('id,order_id,sender_id,message_type,body,attachment_path,created_at').eq('order_id',orderId).order('created_at').limit(500);
   if(error)throw new Error('could not load conversation');
   const {error:readError}=await db.from('chat_read_state').upsert({order_id:orderId,user_id:user.id,last_read_at:new Date().toISOString()},{onConflict:'order_id,user_id'});if(readError)throw new Error('could not update read status');
   const details=role==='owner'?{order_code:order.order_code,buyer_id:order.buyer_id,amount:order.amount,payment_reference:order.flw_tx_ref,status:order.status,delivery_status:order.delivery_status,items:order.order_items}:undefined;
   return json({messages:messages||[],details});
  }
  if(data.action==='send_text'){
   const message=String(data.message||'').trim();if(!message||message.length>4000)throw new Error('message must be 1–4000 characters');
   const {data:allowed,error:rateError}=await db.rpc('consume_chat_rate_limit',{p_user:user.id,p_max:20,p_window_seconds:60});if(rateError||allowed!==true)throw new Error('message limit reached; wait a minute and try again');
   const {data:row,error}=await db.from('chat_messages').insert({order_id:orderId,sender_id:user.id,message_type:'text',body:message}).select('id,order_id,sender_id,message_type,body,created_at').single();if(error||!row)throw new Error('could not send message');await sendPush({event_type:'chat_message',order_id:orderId,actor_id:user.id,message_id:row.id});return json({message:row});
  }
  if(data.action==='mark_delivered'){
   const role=user.app_metadata?.role,owns=role==='owner'||role==='vendor'&&order.order_items.some((i:any)=>i.owner_vendor_id===user.id);if(!owns)throw new Error('forbidden');
   const ownedIds=role==='owner'?order.order_items.map((i:any)=>i.listing_id):order.order_items.filter((i:any)=>i.owner_vendor_id===user.id).map((i:any)=>i.listing_id);
   const {error:updateError}=await db.from('order_items').update({delivery_status:'delivered'}).eq('order_id',orderId).in('listing_id',ownedIds).eq('delivery_type','assisted');if(updateError)throw new Error('could not update delivery status');
   const {data:items,error:itemsError}=await db.from('order_items').select('delivery_type,delivery_status').eq('order_id',orderId);if(itemsError)throw new Error('could not reload delivery status');
   if((items||[]).filter((i:any)=>i.delivery_type==='assisted').every((i:any)=>i.delivery_status==='delivered')){const {error:orderError}=await db.from('orders').update({delivery_status:'delivered'}).eq('id',orderId).eq('status','paid');if(orderError)throw new Error('could not update order status');}
   const {data:row,error}=await db.from('chat_messages').insert({order_id:orderId,sender_id:null,message_type:'system',body:'Vendor marked the assisted delivery as complete.'}).select('id,order_id,sender_id,message_type,body,created_at').single();if(error)throw new Error('delivery updated, but system message could not be saved');return json({message:row,delivery_status:'delivered'});
  }
  if(data.action==='signed_url'){
   const path=String(data.path||'');if(!path.startsWith(`${orderId}/`))throw new Error('invalid attachment');
   const {data:row,error}=await db.from('chat_messages').select('id').eq('order_id',orderId).eq('attachment_path',path).maybeSingle();if(error||!row)throw new Error('attachment not found');
   const {data:signed,error:signedError}=await db.storage.from('order-chat-attachments').createSignedUrl(path,300);if(signedError||!signed?.signedUrl)throw new Error('could not open attachment');return json({url:signed.signedUrl});
  }
  throw new Error('unknown chat action');
 }catch(error){return fail(error);}
});
