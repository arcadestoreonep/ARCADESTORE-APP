import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {constantTimeSecretEqual,isChargeCompletedEvent,webhookRequestStatus} from '../supabase/functions/_shared/webhook.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('webhook signature comparison accepts only the exact non-empty secret',()=>{
 assert.equal(constantTimeSecretEqual('secret-value','secret-value'),true);
 assert.equal(constantTimeSecretEqual('secret-value','wrong-value'),false);
 assert.equal(constantTimeSecretEqual('secret-value',''),false);
 assert.equal(constantTimeSecretEqual('',''),false);
 assert.equal(constantTimeSecretEqual('a'.repeat(257),'a'.repeat(257)),false);
});

test('webhook request gate returns 401 unsigned and 200 only for signed charge.completed with tx_ref',()=>{
 const event={event:'charge.completed',data:{tx_ref:'test-reference'}};
 assert.equal(webhookRequestStatus('hash-value','',event),401);
 assert.equal(webhookRequestStatus('hash-value','wrong',event),401);
 assert.equal(webhookRequestStatus('hash-value','hash-value',{event:'refund.completed',data:{tx_ref:'test-reference'}}),400);
 assert.equal(webhookRequestStatus('hash-value','hash-value',{event:'charge.completed',data:{}}),400);
 assert.equal(webhookRequestStatus('hash-value','hash-value',event),200);
 assert.equal(isChargeCompletedEvent(event),true);
});

test('all app tables in the initial migration have RLS enabled',async()=>{
 const sql=await read('../supabase/migrations/202611060001_initial.sql');
 const tables=['profiles','feature_flags','feature_flag_logs','listings','game_art','listing_secrets','reservations','orders','order_items','ledger','seller_bank_details','payouts','auth_attempts'];
 for(const table of tables){
  assert.match(sql,new RegExp(`create table if not exists public\\.${table}\\b`),`${table} is declared`);
  assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`),`${table} enables RLS`);
 }
});

test('SQL policies preserve owner/buyer checks and booked listing visibility without dropping policies',async()=>{
 const initial=await read('../supabase/migrations/202611060001_initial.sql');
 const booked=await read('../supabase/migrations/202611070002_keep_booked_listings_visible.sql');
 assert.match(initial,/profiles_read_self_or_owner[\s\S]*id=auth\.uid\(\) or public\.is_owner\(\)/);
 assert.match(initial,/order_buyer_or_seller_read[\s\S]*public\.can_view_order\(id\)/);
 assert.match(initial,/revoke all on public\.listing_secrets,public\.auth_attempts from anon,authenticated/);
 assert.match(booked,/alter policy listings_public_or_seller[\s\S]*status in \('published', 'reserved', 'held'\)/i);
 assert.doesNotMatch(booked,/drop\s+policy/i);
 assert.doesNotMatch(initial,/drop\s+(trigger|constraint|policy)/i);
});

test('photo bucket migration sets 5 MiB and JPEG, PNG, WebP without deleting data',async()=>{
 const sql=await read('../supabase/migrations/202611070003_listing_photos_5mb.sql');
 assert.match(sql,/file_size_limit\s*=\s*5242880/i);
 assert.match(sql,/image\/jpeg/);
 assert.match(sql,/image\/png/);
 assert.match(sql,/image\/webp/);
 assert.doesNotMatch(sql,/\bdelete\b|\bdrop\b/i);
});

test('Edge Function service-role grants cover direct listing, chat, order, and push queries',async()=>{
 const migration=await read('../supabase/migrations/202611100002_service_role_edge_table_grants.sql');
 for(const table of ['listing_credentials','listing_transfer_instructions','listing_rental_options','vendor_profiles','order_chats','chat_messages','chat_read_state','orders','order_items','push_subscriptions','push_preferences'])assert.match(migration,new RegExp(`public\\.${table}\\b`),`${table} needs a server grant`);
 assert.match(migration,/grant select on public\.listing_credentials,[\s\S]*?to service_role/);
 assert.match(migration,/grant select, insert, update on public\.vendor_profiles to service_role/);
 assert.match(migration,/grant select, insert on public\.chat_messages to service_role/);
 assert.match(migration,/grant select, insert, update on public\.chat_read_state to service_role/);
 assert.doesNotMatch(migration,/to anon|to authenticated/i);
});

test('browser config points to the intended Supabase project and the app has no stale provider references',async()=>{
 const config=await read('../config.js');
 const authConfig=await read('../supabase/config.toml');
 const files=['../config.js','../supabase/config.toml','../supabase/functions/flutterwave-webhook/index.ts'];
 assert.match(config,/https:\/\/yuejcomfxczdbjlgxcsw\.supabase\.co/);
 assert.match(authConfig,/http:\/\/localhost:8000\/\*\*/);
 assert.match(authConfig,/http:\/\/127\.0\.0\.1:8000\/\*\*/);
 for(const file of files){
  const contents=await read(file);
  assert.doesNotMatch(contents,/ephqgcpjntjotavkbrxb|bjmxpfwwgtavgxclqqgo|payscrow/i,file);
 }
});

test('landing uses only the three supplied static game images; ordinary signed-in startup stays on Market',async()=>{
 const app=await read('../src/main.js');
 for(const path of ['./assets/games/bloodstrike.jpg','./assets/games/free-fire.jpg','./assets/games/call-of-duty.jpg'])assert.match(app,new RegExp(path.replaceAll('.','\\.')));
 assert.match(app,/async function init\(\)[\s\S]*if\(state\.backend&&state\.session\)\{if\(state\.screen==='home'\)setScreen\('Market'\);else render\(\);/);
 assert.doesNotMatch(app,/state\.gameArt\[game\]/);
 const startup=app.match(/async function init\(\)\{([^}]+(?:\}[^}]+)?)\}/)?.[1]||'';
 assert.doesNotMatch(startup,/loadGameArt/);
});

test('checkout payload uses Flutterwave Standard API configuration spelling',async()=>{
 const checkout=await read('../supabase/functions/checkout/index.ts');
 const operations=await read('../supabase/functions/_shared/operations.mjs');
 assert.match(checkout,/flutterwavePaymentRequest/);
 assert.match(operations,/configuration:\{session_duration:20,max_retry_attempt:3\}/);
 assert.doesNotMatch(operations,/configurations:/);
});

test('vendor, dynamic credential, rental, and chat migration keeps sensitive data protected',async()=>{
 const sql=await read('../supabase/migrations/202611090001_vendor_rentals_chat.sql');
 for(const table of ['vendor_profiles','listing_credentials','listing_transfer_instructions','listing_rental_options','order_chats','chat_messages','chat_read_state','chat_rate_limits']){
  assert.match(sql,new RegExp(`create table if not exists public\\.${table}\\b`),`${table} is created`);
  assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`),`${table} enables RLS`);
 }
 assert.match(sql,/owner_type text not null default 'platform'/);
 assert.match(sql,/protect_listing_vendor_owner/);
 assert.match(sql,/o\.status='paid' and o\.buyer_id=auth\.uid\(\) and i\.listing_id=listing_id/);
 assert.match(sql,/public\.can_access_order_chat\(order_id\)/);
 assert.match(sql,/file_size_limit,allowed_mime_types[\s\S]*5242880[\s\S]*image\/jpeg[\s\S]*image\/png[\s\S]*image\/webp/);
 assert.match(sql,/revoke insert,update,delete on public\.listings,public\.listing_rental_options,public\.order_chats,public\.chat_messages from anon,authenticated/);
 assert.match(sql,/alter publication supabase_realtime add table public\.chat_messages/);
});

test('rental expiry runs from the database scheduler and returns expired listings to availability',async()=>{
 const schedule=await read('../supabase/migrations/202611090002_rental_expiry_schedule.sql');
 const migration=await read('../supabase/migrations/202611090001_vendor_rentals_chat.sql');
 assert.match(schedule,/\* \* \* \* \*.*public\.expire_rentals\(\)/);
 assert.match(migration,/create or replace function public\.expire_rentals\(\)/);
 assert.match(migration,/delivery_status='rental_expired'/);
 assert.match(migration,/status='active',updated_at=now\(\)/);
});

test('vendor and buyer credential access is restricted by order ownership and payment state',async()=>{
 const sql=await read('../supabase/migrations/202611090001_vendor_rentals_chat.sql');
 const credentials=sql.match(/create policy listing_credentials_permitted_read[\s\S]*?create policy listing_transfer_permitted_read/i)?.[0]||'';
 assert.match(credentials,/public\.is_owner\(\)/);
 assert.match(credentials,/vendor_profiles v[\s\S]*v\.user_id=auth\.uid\(\)/);
 assert.match(credentials,/o\.status='paid'[\s\S]*o\.buyer_id=auth\.uid\(\)/);
 assert.match(sql,/create trigger protect_listing_vendor_owner_trigger before update of owner_vendor_id,owner_type/i);
 assert.match(sql,/coalesce\(current_setting\('request\.jwt\.claim\.role',true\),''\)\s*<>\s*'service_role'/i);
});

test('chat policies scope access to a paid buyer, exact vendor owner, or owner support',async()=>{
 const sql=await read('../supabase/migrations/202611090001_vendor_rentals_chat.sql');
 const access=sql.match(/create or replace function public\.can_access_order_chat[\s\S]*?\$\$;/i)?.[0]||'';
 assert.match(access,/o\.status='paid'/);
 assert.match(access,/o\.buyer_id=auth\.uid\(\)/);
 assert.match(access,/public\.is_owner\(\)/);
 assert.match(access,/i\.owner_vendor_id=auth\.uid\(\)/);
 assert.doesNotMatch(access,/i\.seller_id=auth\.uid\(\)/);
 assert.match(sql,/revoke insert,update,delete on public\.listings,public\.listing_rental_options,public\.order_chats,public\.chat_messages from anon,authenticated/);
 const chat=await read('../supabase/functions/order-chat/index.ts');
 const upload=await read('../supabase/functions/order-chat-upload/index.ts');
 assert.match(chat,/message_type:'text'/);
 assert.match(chat,/createSignedUrl\(path,300\)/);
 assert.match(upload,/file\.size>5\*1024\*1024/);
 assert.match(upload,/image\/jpeg[\s\S]*image\/png[\s\S]*image\/webp/);
 assert.match(upload,/owner_vendor_id===user\.id/);
});

test('checkout routes vendor subaccount IDs server-side and never computes fee amounts',async()=>{
 const checkout=await read('../supabase/functions/checkout/index.ts');
 const core=await read('../supabase/functions/_shared/core.mjs');
 const routingMigration=await read('../supabase/migrations/202611100003_subaccount_dashboard_routing.sql');
 const vendor=await read('../supabase/functions/vendor/index.ts');
 const admin=await read('../supabase/functions/admin/index.ts');
 const release=await read('../supabase/functions/release-reservation/index.ts');
 const credentials=await read('../supabase/functions/order-credentials/index.ts');
 assert.doesNotMatch(checkout,/PLATFORM_COMMISSION_PERCENT|p_commission_percent/);
 assert.match(checkout,/create_cart_order',\{p_buyer:user\.id,p_tx_ref:txRef\}/);
 assert.match(checkout,/vendor_subaccount_id/);
 assert.ok(checkout.indexOf("db.rpc('create_cart_order'")<checkout.indexOf("flwRequest(secret,"),'the database must reject missing subaccounts before Flutterwave is called');
 assert.ok(checkout.indexOf('resolveCheckoutRouting(items)')<checkout.indexOf('flwRequest(secret,'),'routing validation must finish before Flutterwave is called');
 assert.match(core,/subaccounts\.set\(item\.vendor_subaccount_id,\{id:item\.vendor_subaccount_id\}\)/);
 assert.match(core,/Ask the Arcade Store owner to add the vendor Flutterwave subaccount ID/);
 assert.doesNotMatch(core,/commission|transaction_charge|percentage|gross\s*\*/i);
 assert.match(routingMigration,/create function public\.create_cart_order\(p_buyer uuid,p_tx_ref text\)/);
 assert.match(routingMigration,/raise exception 'Vendor payment setup is incomplete\.[\s\S]*?';/);
 assert.ok(routingMigration.indexOf("if r.owner_type='vendor' and r.flw_subaccount_id is null")<routingMigration.indexOf('insert into public.order_items'),'missing subaccounts must abort the database function before order items are created');
 assert.match(routingMigration,/r\.item_price,0,r\.item_price/);
 assert.doesNotMatch(routingMigration,/p_commission_percent|transaction_charge|round\([^)]*\/|percentage/i);
 assert.match(vendor,/requireRole\(user,\['vendor'\]\)/);
 assert.match(vendor,/eq\('owner_vendor_id',user\.id\)/);
 assert.match(admin,/if\(data\.action==='set_vendor_profile'\)[\s\S]*ownerOnly\(\)/);
 assert.match(credentials,/order\.status==='paid'/);
 assert.match(credentials,/i\.owner_vendor_id===user\.id/);
 assert.match(release,/r\.status==='checkout'[\s\S]*cancel_checkout/);
 const app=await read('../src/main.js');
 assert.match(app,/apiFunction\('checkout',\{\}\)/);
 assert.doesNotMatch(app,/apiFunction\('checkout',\{[^}]*?(?:subaccount|recipient)/i);
 assert.match(app,/order-chat-upload/);
});

test('commission secret is absent from current configuration, checkout, helpers, and docs',async()=>{
 const files=['../.env.example','../README.md','../supabase/functions/checkout/index.ts','../supabase/functions/_shared/core.mjs','../supabase/functions/_shared/operations.mjs'];
 for(const file of files)assert.doesNotMatch(await read(file),/PLATFORM_COMMISSION_PERCENT/i,file);
});
