import {decryptCredentials,encryptCredentials,validateCredentialEntries} from './core.mjs';

export async function writeListingConfiguration(db,listingId,{credentials,transferInstructions='',rentalOptions=[]},key){
 const fields=validateCredentialEntries(credentials);
 const encrypted=await Promise.all(fields.map(async field=>{
  const secret=await encryptCredentials(field.value,key);
  return{label:field.label,ciphertext:secret.ciphertext,iv:secret.iv,sort_order:field.sort_order};
 }));
 const text=String(transferInstructions||'');
 const transfer=text.trim()?await encryptCredentials(text,key):null;
 const options=(rentalOptions||[]).map(option=>({duration_days:Number(option.duration_days),price:Number(option.price)}));
 if(options.some(option=>!Number.isInteger(option.duration_days)||option.duration_days<1||option.duration_days>365||!Number.isSafeInteger(option.price)||option.price<1))throw new Error('rental durations and prices must be valid');
 if(new Set(options.map(option=>option.duration_days)).size!==options.length)throw new Error('rental durations must be unique');
 const {data,error}=await db.rpc('replace_listing_configuration',{
  p_listing:listingId,p_credentials:encrypted,p_transfer_ciphertext:transfer?.ciphertext||null,p_transfer_iv:transfer?.iv||null,p_rental_options:options,
 });
 if(error||data!==true)throw new Error('Could not securely save listing fields');
}

export async function readListingConfiguration(db,listingId,key){
 const [{data:fields,error:fieldError},{data:transfer,error:transferError},{data:rentalOptions,error:optionError}]=await Promise.all([
  db.from('listing_credentials').select('label,ciphertext,iv,sort_order').eq('listing_id',listingId).order('sort_order'),
  db.from('listing_transfer_instructions').select('ciphertext,iv').eq('listing_id',listingId).maybeSingle(),
  db.from('listing_rental_options').select('duration_days,price,enabled').eq('listing_id',listingId).order('duration_days'),
 ]);
 if(fieldError||transferError||optionError)throw new Error('Could not load listing details');
 let credentials=[];
 if(fields?.length){credentials=await Promise.all(fields.map(async field=>({label:field.label,value:await decryptCredentials(field,key)})));}
 else{
  const {data:legacy,error}=await db.from('listing_secrets').select('ciphertext,iv').eq('listing_id',listingId).maybeSingle();
  if(error)throw new Error('Could not load legacy listing credentials');
  if(legacy){const decoded=await decryptCredentials(legacy,key);credentials=(Array.isArray(decoded)?decoded:[]).flatMap(entry=>[
   ...(entry.login?[{label:'Account login',value:String(entry.login)}]:[]),
   ...(entry.password?[{label:'Account password',value:String(entry.password)}]:[]),
   ...(entry.recovery?[{label:'Recovery details',value:String(entry.recovery)}]:[]),
   ...(entry.notes?[{label:String(entry.label||'Notes'),value:String(entry.notes)}]:[]),
  ]);}
 }
 const transferInstructions=transfer?await decryptCredentials(transfer,key):'';
 return{credentials,transferInstructions,rental_options:rentalOptions||[]};
}
