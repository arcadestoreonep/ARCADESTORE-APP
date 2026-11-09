import {sendPush} from '../_shared/push.ts';
import {env,fail,identity,json,service} from '../_shared/server.ts';
import {requireRole} from '../_shared/core.mjs';

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}});
 try{
  const {user}=await identity(req);requireRole(user,['buyer','vendor','owner']);
  const form=await req.formData(),orderId=String(form.get('order_id')||''),file=form.get('file');
  if(!(file instanceof File))throw new Error('choose an image to send');
  if(file.size<1||file.size>5*1024*1024)throw new Error('image must be 5 MB or smaller');
  const types:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};const ext=types[file.type];if(!ext)throw new Error('only JPEG, PNG, or WebP images are allowed');
  const db=service(),{data:order,error}=await db.from('orders').select('id,buyer_id,status,order_items(seller_id,owner_vendor_id,delivery_type)').eq('id',orderId).maybeSingle();if(error||!order||order.status!=='paid')throw new Error('paid order chat not found');
  const role=user.app_metadata?.role,allowed=order.buyer_id===user.id||role==='owner'||role==='vendor'&&order.order_items.some((i:any)=>i.owner_vendor_id===user.id);
  if(!allowed||!order.order_items.some((i:any)=>i.delivery_type==='assisted'||i.delivery_type==='rental'))throw new Error('forbidden');
  const {data:rate,error:rateError}=await db.rpc('consume_chat_rate_limit',{p_user:user.id,p_max:20,p_window_seconds:60});if(rateError||rate!==true)throw new Error('message limit reached; wait a minute and try again');
  const path=`${orderId}/${user.id}/${crypto.randomUUID()}.${ext}`,bytes=new Uint8Array(await file.arrayBuffer());
  const {error:uploadError}=await db.storage.from('order-chat-attachments').upload(path,bytes,{contentType:file.type,upsert:false});if(uploadError)throw new Error('could not upload image');
  const {data:message,error:insertError}=await db.from('chat_messages').insert({order_id:orderId,sender_id:user.id,message_type:'image',attachment_path:path}).select('id,order_id,sender_id,message_type,attachment_path,created_at').single();
  if(insertError){await db.storage.from('order-chat-attachments').remove([path]);throw new Error('could not save image message');}
  await sendPush({event_type:'chat_message',order_id:orderId,actor_id:user.id,message_id:message.id});
  return json({message});
 }catch(error){return fail(error);}
});
