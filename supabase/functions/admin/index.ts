import {body,env,fail,featureMap,identity,json,service} from '../_shared/server.ts';
import {listingDatabaseFailure,readListingConfiguration,writeListingConfiguration} from '../_shared/listings.mjs';
import {requireFeature,requireRole} from '../_shared/core.mjs';

const games=['Bloodstrike','Free Fire','Call of Duty'];
const deliveryTypes=['instant','assisted','rental'];
const ownerId=()=>env('OWNER_USER_ID');
const isOwner=(user:any)=>user.app_metadata?.role==='owner'&&user.id===ownerId();
const ensureOwner=(user:any)=>{if(!isOwner(user))throw new Error('forbidden');};
function listingValues(data:any){
 const game=String(data.game||'');
 const price=Number(data.price);
 const deliveryType=String(data.delivery_type||'instant');
 const description=String(data.description||'').trim().slice(0,700);
 if(!games.includes(game)||!Number.isSafeInteger(price)||price<1||!description||!deliveryTypes.includes(deliveryType))throw new Error('invalid listing details');
 const rentalOptions=Array.isArray(data.rental_options)?data.rental_options:[];
 if(deliveryType==='rental'&&!rentalOptions.length)throw new Error('rental listings need at least one duration and price');
 return{game,price,description,delivery_type:deliveryType,rentalOptions};
}

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}});
 try{
  const {user}=await identity(req),role=requireRole(user,['owner','admin']),data=await body(req),db=service(),flags=await featureMap(db),key=env('CREDENTIALS_ENCRYPTION_KEY');
  const ownerOnly=()=>ensureOwner(user);
  const getListing=async(id:string)=>{const {data:listing,error}=await db.from('listings').select('*').eq('id',id).maybeSingle();if(error||!listing)throw new Error('listing not found');if(role!=='owner'&&listing.seller_id!==user.id)throw new Error('forbidden');return listing;};

  if(data.action==='set_flag'){
   ownerOnly();const {error}=await db.rpc('owner_set_flag',{p_owner:user.id,p_key:data.key,p_enabled:!!data.enabled});if(error)throw new Error(error.message);return json({ok:true});
  }
  if(data.action==='set_vendor_profile'){
   ownerOnly();const admin=service();let userId=String(data.user_id||'');if(!userId&&data.email){const {data:found,error:findError}=await admin.auth.admin.listUsers({page:1,perPage:1000});if(findError)throw new Error('could not find user');const target=found.users.find((u:any)=>u.email?.toLowerCase()===String(data.email).toLowerCase());if(!target)throw new Error('user not found; ask them to create an account first');userId=target.id;}if(!userId)throw new Error('vendor email is required');
   const {data:target,error:lookupError}=await admin.auth.admin.getUserById(userId);if(lookupError||!target.user)throw new Error('vendor user not found');if(target.user.id===ownerId()||['owner','admin'].includes(target.user.app_metadata?.role))throw new Error('owner and admin accounts cannot be converted to vendor accounts');
   const {data:profile,error}=await db.from('vendor_profiles').upsert({user_id:userId,verified_partner:!!data.verified_partner,flw_subaccount_id:String(data.flw_subaccount_id||'').trim()||null,updated_by:user.id,updated_at:new Date().toISOString()},{onConflict:'user_id'}).select('user_id').single();
   if(error||!profile)throw new Error('could not save vendor profile');
   const app_metadata={...(target.user.app_metadata||{}),role:'vendor'};const {error:roleError}=await admin.auth.admin.updateUserById(userId,{app_metadata});if(roleError)throw new Error('could not assign vendor role');
   return json({ok:true});
  }
  if(data.action==='create_listing'){
   requireFeature(flags,'admin_publishing');const values=listingValues(data);
   const {rentalOptions,...columns}=values;const {data:listing,error}=await db.from('listings').insert({seller_id:user.id,owner_type:'platform',owner_vendor_id:null,...columns,status:'draft'}).select('id').single();
   if(error||!listing)throw listingDatabaseFailure(error,'Could not create the listing');
   try{await writeListingConfiguration(db,listing.id,{credentials:data.credentials,transferInstructions:data.transfer_instructions,rentalOptions:values.delivery_type==='rental'?values.rentalOptions:[]},key,{allowEmptyCredentials:data.save_as_draft===true});}
   catch(error){await db.from('listings').delete().eq('id',listing.id);throw error;}
   return json({listing_id:listing.id});
  }
  if(data.action==='get_listing'){
   const listing=await getListing(String(data.listing_id||''));const config=await readListingConfiguration(db,listing.id,key);
   let photo_url='';if(listing.photo_path)photo_url=db.storage.from('listing-photos').getPublicUrl(listing.photo_path).data.publicUrl;
   return json({...listing,...config,photo_url});
  }
  if(data.action==='update_listing'){
   const listing=await getListing(String(data.listing_id||''));if(['reserved','held','sold','rented','deleted'].includes(listing.status))throw new Error('this listing cannot be edited in its current status');
   const values=listingValues(data);const {error}=await db.from('listings').update({game:values.game,price:values.price,description:values.description,delivery_type:values.delivery_type,updated_at:new Date().toISOString(),updated_by:user.id}).eq('id',listing.id);
   if(error)throw listingDatabaseFailure(error,'Could not update the listing');
   await writeListingConfiguration(db,listing.id,{credentials:data.credentials,transferInstructions:data.transfer_instructions,rentalOptions:values.delivery_type==='rental'?values.rentalOptions:[]},key,{allowEmptyCredentials:data.save_as_draft===true&&listing.status==='draft'});
   return json({ok:true,listing_id:listing.id});
  }
  if(data.action==='add_listing_credentials'){
   ownerOnly();const listing=await getListing(String(data.listing_id||''));if(['reserved','held','sold','rented','deleted'].includes(listing.status))throw new Error('release the listing before changing credentials');
   const previous=await readListingConfiguration(db,listing.id,key),extra=(data.credentials||[]).flatMap((entry:any)=>[
    ...(entry.login?[{label:`${entry.label||'Account'} login`,value:String(entry.login)}]:[]),
    ...(entry.password?[{label:`${entry.label||'Account'} password`,value:String(entry.password)}]:[]),
    ...(entry.recovery?[{label:'Recovery details',value:String(entry.recovery)}]:[]),
    ...(entry.notes?[{label:'Credential notes',value:String(entry.notes)}]:[]),
   ]);await writeListingConfiguration(db,listing.id,{credentials:[...previous.credentials,...extra],transferInstructions:previous.transferInstructions,rentalOptions:previous.rental_options.filter((x:any)=>x.enabled)},key);return json({ok:true});
  }
  if(data.action==='set_listing_photo'){
   const listing=await getListing(String(data.listing_id||''));if(['reserved','held','sold','rented','deleted'].includes(listing.status))throw new Error('release the listing before changing its photo');
   const path=String(data.photo_path||'');if(!path.startsWith(`${user.id}/${listing.id}/`))throw new Error('invalid photo path');
   const oldPath=listing.photo_path;const {error}=await db.from('listings').update({photo_path:path,updated_by:user.id,updated_at:new Date().toISOString()}).eq('id',listing.id);if(error)throw new Error('could not save the listing photo');
   if(oldPath&&oldPath!==path)await db.storage.from('listing-photos').remove([oldPath]);return json({ok:true});
  }
  if(['publish_listing','hide_listing','delete_listing'].includes(data.action)){
   const listing=await getListing(String(data.listing_id||''));
   if(data.action==='publish_listing'){
    requireFeature(flags,'admin_publishing');if(!['draft','hidden','paused','published','active'].includes(listing.status))throw new Error('listing cannot be activated from this state');
    const {count,error:credentialError}=await db.from('listing_credentials').select('id',{count:'exact',head:true}).eq('listing_id',listing.id);if(credentialError)throw listingDatabaseFailure(credentialError,'Could not check listing credentials');const {data:legacy,error:legacyError}=await db.from('listing_secrets').select('listing_id').eq('listing_id',listing.id).maybeSingle();if(legacyError)throw listingDatabaseFailure(legacyError,'Could not check legacy listing credentials');if(!count&&!legacy)throw new Error('Add at least one credential before publishing this listing.');
    if(listing.delivery_type==='rental'){const {count:options}=await db.from('listing_rental_options').select('id',{count:'exact',head:true}).eq('listing_id',listing.id).eq('enabled',true);if(!options)throw new Error('add an available rental duration before publishing');}
    const {error}=await db.from('listings').update({status:'active',updated_by:user.id,updated_at:new Date().toISOString()}).eq('id',listing.id);if(error)throw listingDatabaseFailure(error,'Could not publish the listing');return json({ok:true});
   }
   if(data.action==='hide_listing'){
    if(['reserved','held','sold','rented'].includes(listing.status))throw new Error('reserved, paid, or rented listings cannot be paused');
    const {error}=await db.from('listings').update({status:'paused',updated_by:user.id,updated_at:new Date().toISOString()}).eq('id',listing.id);if(error)throw new Error('could not pause listing');return json({ok:true});
   }
   if(['reserved','held','rented'].includes(listing.status))throw new Error('reserved or rented listings cannot be deleted');
   for(const table of ['listing_credentials','listing_transfer_instructions','listing_rental_options','listing_secrets'])await db.from(table).delete().eq('listing_id',listing.id);
   if(listing.photo_path)await db.storage.from('listing-photos').remove([listing.photo_path]);
   const {error}=await db.from('listings').update({status:'deleted',deleted_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',listing.id);if(error)throw new Error('could not delete listing');return json({ok:true});
  }
  if(data.action==='release_reservation'){
   ownerOnly();const {data:released,error}=await db.rpc('owner_release_reservation',{p_owner:user.id,p_reservation:data.reservation_id});if(error)throw new Error(error.message);if(!released)throw new Error('reservation is already closed or cannot be removed');return json({ok:true});
  }
  if(data.action==='mark_refunded'){
   ownerOnly();const {data:ok,error}=await db.rpc('mark_order_refunded',{p_owner:user.id,p_order:data.order_id});if(error)throw new Error(error.message);if(!ok)throw new Error('order is not awaiting refund');return json({ok:true});
  }
  if(data.action==='add_admin'||data.action==='remove_admin'){
   ownerOnly();const admin=service(),{data:users,error}=await admin.auth.admin.listUsers({page:1,perPage:1000});if(error)throw new Error('could not find user');const target=users.users.find((u:any)=>u.email?.toLowerCase()===String(data.email||'').toLowerCase());if(!target)throw new Error('user not found; ask them to create an account first');if(target.id===user.id)throw new Error('owner role cannot be changed');const app_metadata={...(target.app_metadata||{}),role:data.action==='add_admin'?'admin':'buyer'};const {error:updateError}=await admin.auth.admin.updateUserById(target.id,{app_metadata});if(updateError)throw new Error('could not update user role');return json({ok:true});
  }
  if(data.action==='dashboard'){
   const owner=role==='owner';let q=db.from('listings').select('id,status',{count:'exact',head:true}).neq('status','deleted');if(!owner)q=q.eq('seller_id',user.id);const {count,error}=await q;if(error)throw new Error('could not load listing totals');const {data:bal,error:balanceError}=await db.rpc('available_balance',{p_user:user.id});if(balanceError)throw new Error('could not load balance');return json({listings:count||0,balance:bal||0});
  }
  if(data.action==='list_listings'){
   let q=db.from('listings').select('id,listing_code,game,price,description,status,photo_path,seller_id,owner_type,owner_vendor_id,delivery_type,created_at').neq('status','deleted').order('created_at',{ascending:false});if(role!=='owner')q=q.eq('seller_id',user.id);const {data:rows,error}=await q;if(error)throw new Error('could not load listings');const ids=(rows||[]).map((l:any)=>l.id);let reservations:any[]=[];if(ids.length){const {data:held,error:reservationError}=await db.from('reservations').select('id,listing_id,buyer_id,status,expires_at').in('listing_id',ids).in('status',['active','checkout']);if(reservationError)throw new Error('could not load listing reservations');reservations=held||[];}return json({listings:(rows||[]).map((l:any)=>({...l,reservation:reservations.find((r:any)=>r.listing_id===l.id)||null}))});
  }
  if(data.action==='list_orders'){
   let query=db.from('orders').select('id,order_code,buyer_id,amount,status,delivery_status,rental_started_at,rental_expires_at,flw_tx_ref,checkout_url,hold_until,refund_reason,created_at,paid_at,order_items(game,listing_id,seller_id,owner_vendor_id,delivery_type,rental_days,rental_started_at,rental_expires_at,delivery_status)').order('created_at',{ascending:false}).limit(200);if(role!=='owner'){const {data:items,error}=await db.from('order_items').select('order_id').eq('seller_id',user.id);if(error)throw new Error('could not load vendor orders');const ids=[...new Set((items||[]).map((x:any)=>x.order_id))];if(!ids.length)return json({orders:[]});query=query.in('id',ids);}const {data:rows,error}=await query;if(error)throw new Error('could not load orders');return json({orders:rows||[]});
  }
  if(data.action==='list_sales'){
   ownerOnly();const {data:rows,error}=await db.from('orders').select('id,order_code,amount,paid_at,created_at,delivery_status,order_items(game,listing_id,delivery_type)').eq('status','paid').order('paid_at',{ascending:false,nullsFirst:false}).limit(100);if(error)throw new Error('could not load confirmed sales');return json({sales:rows||[]});
  }
  if(data.action==='list_admins'){
   ownerOnly();const admin=service(),{data:users,error}=await admin.auth.admin.listUsers({page:1,perPage:1000});if(error)throw new Error('could not load users');return json({users:users.users.filter((u:any)=>u.app_metadata?.role==='admin').map((u:any)=>({id:u.id,email:u.email}))});
  }
  throw new Error('unknown admin action');
 }catch(error){return fail(error);}
});
