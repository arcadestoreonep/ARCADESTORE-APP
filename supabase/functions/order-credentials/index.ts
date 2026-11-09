import {body,fail,identity,json,service} from '../_shared/server.ts';
import {readListingConfiguration} from '../_shared/listings.mjs';
import {requireRole} from '../_shared/core.mjs';
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}});
 try{
  const {user}=await identity(req),role=requireRole(user,['buyer','vendor','owner']),data=await body(req),db=service(),key=Deno.env.get('CREDENTIALS_ENCRYPTION_KEY')||'';if(!key)throw new Error('credential service unavailable');
  const {data:order,error}=await db.from('orders').select('id,order_code,buyer_id,status,delivery_status,order_items(listing_id,seller_id,owner_vendor_id,delivery_type)').eq('id',data.order_id).maybeSingle();if(error||!order)throw new Error('order not found');
  const allowed=order.status==='paid'&&(order.buyer_id===user.id||role==='owner'||role==='vendor'&&order.order_items.some((i:any)=>i.owner_vendor_id===user.id));if(!allowed)throw new Error('credentials are available only to the paid buyer or listing owner');
  const eligible=order.order_items.filter((i:any)=>['instant','rental'].includes(i.delivery_type));if(!eligible.length)throw new Error('assisted delivery details are completed through the private order chat');
  const credentials:any[]=[],instructions:string[]=[];
  for(const item of eligible){const cfg=await readListingConfiguration(db,item.listing_id,key);credentials.push(...cfg.credentials);if(cfg.transferInstructions)instructions.push(cfg.transferInstructions);}
  return json({order_code:order.order_code,delivery_status:order.delivery_status,credentials,transfer_instructions:instructions.join('\n\n')});
 }catch(error){return fail(error);}
});
