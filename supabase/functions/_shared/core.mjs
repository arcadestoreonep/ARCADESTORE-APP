export const DEFAULT_FLAGS=Object.freeze({buyer_selling:false,admin_publishing:true,reservations:true,checkout:true,payouts:false,live_payments:false});
export const ROLES=Object.freeze(['owner','admin','vendor','buyer']);
export function userRole(user){return user?.app_metadata?.role||'buyer';}
export function requireRole(user,allowed){const role=userRole(user);if(!allowed.includes(role))throw new Error('forbidden');return role;}
export function requireFeature(flags,key){if(!Object.hasOwn(DEFAULT_FLAGS,key))throw new Error('unknown feature');if(!flags?.[key])throw new Error('feature disabled');return true;}
export function validateFlutterwaveKey(mode,secret){const selected=String(mode||'test').toLowerCase(),key=String(secret||'');if(!['test','live'].includes(selected))throw new Error('FLW_MODE must be test or live');if(selected==='test'&&!key.startsWith('FLWSECK_TEST-')||selected==='live'&&(!key.startsWith('FLWSECK-')||key.startsWith('FLWSECK_TEST-')))throw new Error('Flutterwave mode and server key do not match');return selected;}
export function commissionAmounts(gross,isPlatformOwned,commissionPercent){if(!Number.isSafeInteger(gross)||gross<0)throw new Error('invalid amount');const percent=Number(commissionPercent);if(!Number.isFinite(percent)||percent<0||percent>100)throw new Error('PLATFORM_COMMISSION_PERCENT must be from 0 to 100');const fee=isPlatformOwned?0:Math.round(gross*percent/100);return{gross,commission:fee,net:gross-fee};}
export function commissionPercentFromConfig(value){const percent=Number(value);if(!Number.isFinite(percent)||percent<0||percent>100)throw new Error('PLATFORM_COMMISSION_PERCENT must be from 0 to 100');return percent;}
export function resolveCheckoutRouting(items,commissionPercent){
 if(!Array.isArray(items)||items.length===0)throw new Error('order has no items');
 const rate=commissionPercentFromConfig(commissionPercent),subaccounts=new Map();let platformGross=0,commissionTotal=0;
 for(const item of items){
  if(!['platform','vendor'].includes(item.owner_type))throw new Error('listing owner cannot be determined');
  const gross=Number(item.gross);if(!Number.isSafeInteger(gross)||gross<=0)throw new Error('invalid order item amount');
  if(item.owner_type==='platform'){if(item.owner_vendor_id)throw new Error('invalid platform listing owner');platformGross+=gross;continue;}
  if(!item.owner_vendor_id||!item.vendor_subaccount_id)throw new Error('vendor Flutterwave subaccount is missing');
  const amount=commissionAmounts(gross,false,rate);commissionTotal+=amount.commission;
  const current=subaccounts.get(item.vendor_subaccount_id)||{id:item.vendor_subaccount_id,transaction_charge_type:'flat_subaccount',transaction_charge:0};
  current.transaction_charge+=amount.net;subaccounts.set(item.vendor_subaccount_id,current);
 }
 return{recipient:subaccounts.size?'split':'platform',subaccounts:[...subaccounts.values()],platformGross,commissionTotal,commissionPercent:rate};
}
export function ledgerBalance(entries=[]){return entries.reduce((balance,row)=>balance+(row.direction==='credit'?Number(row.amount):-Number(row.amount)),0);}
export function reservationExpired(reservation,now=Date.now()){return !reservation||reservation.status!=='active'||new Date(reservation.expires_at).getTime()<=now;}
export function holdExpired(order,now=Date.now()){return !order?.hold_until||new Date(order.hold_until).getTime()<=now;}
export function canReserve(listing,reservationsEnabled=true){return !!reservationsEnabled&&['published','active'].includes(listing?.status);}
export function listingDeleteAllowed(status){return status==='published'||status==='draft'||status==='hidden'||status==='sold';}
export function validateSettlement(order,transaction,now=Date.now()){
 if(['paid','complete'].includes(order?.status))return{ok:true,duplicate:true};
 if(!transaction||transaction.status!=='successful')return{ok:false,reason:'not_successful'};
 if(String(transaction.tx_ref)!==String(order?.flw_tx_ref)||String(transaction.currency)!=='NGN'||Number(transaction.amount)!==Number(order?.amount))return{ok:false,reason:'mismatch'};
 if(order?.status!=='held'||holdExpired(order,now))return{ok:false,reason:'needs_refund',late:true};
 return{ok:true,duplicate:false};
}
export function payoutCheck({flags,user,amount,balance,profileName,verifiedName}){
 requireFeature(flags,'payouts');requireRole(user,['owner','admin']);
 if(!Number.isSafeInteger(Number(amount))||Number(amount)<5000)return{ok:false,reason:'minimum'};
 if(Number(amount)>Number(balance))return{ok:false,reason:'insufficient_balance'};
 if(!profileName||!verifiedName||normalizeName(profileName)!==normalizeName(verifiedName))return{ok:false,reason:'name_mismatch'};
 return{ok:true};
}
export function normalizeName(name){return String(name||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
function fromBase64(text){const raw=atob(text);return Uint8Array.from(raw,c=>c.charCodeAt(0));}
function toBase64(bytes){let raw='';for(const b of bytes)raw+=String.fromCharCode(b);return btoa(raw);}
async function aesKey(encoded){const raw=fromBase64(encoded);if(raw.byteLength!==32)throw new Error('CREDENTIALS_ENCRYPTION_KEY must be base64 for exactly 32 bytes');return crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function encryptCredentials(value,encodedKey){const iv=crypto.getRandomValues(new Uint8Array(12)),key=await aesKey(encodedKey),plain=new TextEncoder().encode(JSON.stringify(value)),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);return{iv:toBase64(iv),ciphertext:toBase64(new Uint8Array(cipher))};}
export async function decryptCredentials(record,encodedKey){const key=await aesKey(encodedKey),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(record.iv)},key,fromBase64(record.ciphertext));return JSON.parse(new TextDecoder().decode(plain));}
export function validateCredentialEntries(entries){if(!Array.isArray(entries)||entries.length<1||entries.length>30)throw new Error('add at least one credential field');return entries.map((entry,index)=>{const label=String(entry?.label||'').trim().slice(0,80),value=String(entry?.value??'');if(!label||!value.trim()||value.length>4000)throw new Error('credential labels and values are required');return{label,value,sort_order:index};});}
export function rentalExpiry(startedAt,durationDays){const days=Number(durationDays);if(!Number.isInteger(days)||days<1||days>365)throw new Error('rental duration must be from 1 to 365 days');const start=new Date(startedAt);if(Number.isNaN(start.getTime()))throw new Error('invalid rental start date');return new Date(start.getTime()+days*86400000).toISOString();}
export function chatParticipantAllowed({role,userId,buyerId,vendorId,orderPaid}){return !!orderPaid&&(role==='owner'||userId===buyerId||!!vendorId&&userId===vendorId);}
export function chatImageAllowed({mimeType,size}){return ['image/jpeg','image/png','image/webp'].includes(String(mimeType||'').toLowerCase())&&Number.isSafeInteger(Number(size))&&Number(size)>0&&Number(size)<=5242880;}
export function chatMessageWarning(text){const value=String(text||'');return /\b(?:your|own|personal)\s+(?:email|gmail|icloud|outlook|account)\s+(?:password|passcode)\b|\b(?:send|share|tell|give)\s+(?:me\s+)?(?:your|own|personal)\s+(?:email|gmail|icloud|outlook|account)\s+(?:password|passcode)\b/i.test(value);}
