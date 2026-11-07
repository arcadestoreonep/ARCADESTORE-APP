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

test('browser config points to the intended Supabase project and the app has no stale provider references',async()=>{
 const config=await read('../config.js');
 const files=['../config.js','../supabase/config.toml','../supabase/functions/flutterwave-webhook/index.ts'];
 assert.match(config,/https:\/\/yuejcomfxczdbjlgxcsw\.supabase\.co/);
 for(const file of files){
  const contents=await read(file);
  assert.doesNotMatch(contents,/ephqgcpjntjotavkbrxb|bjmxpfwwgtavgxclqqgo|payscrow/i,file);
 }
});

test('signed-in buyers still land on the game artwork homepage',async()=>{
 const app=await read('../src/main.js');
 assert.match(app,/async function init\(\)[\s\S]*setScreen\('home'\)/);
 assert.match(app,/game-picker-grid/);
 assert.match(app,/state\.gameArt\[game\]/);
 assert.doesNotMatch(app,/alt="\$\{esc\(game\)\} logo" loading="lazy"/);
});

test('checkout payload uses Flutterwave Standard API configuration spelling',async()=>{
 const checkout=await read('../supabase/functions/checkout/index.ts');
 const operations=await read('../supabase/functions/_shared/operations.mjs');
 assert.match(checkout,/flutterwavePaymentRequest/);
 assert.match(operations,/configuration:\{session_duration:20,max_retry_attempt:3\}/);
 assert.doesNotMatch(operations,/configurations:/);
});
