import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {pushCopy,pushRecipients,pushTarget} from '../supabase/functions/_shared/push.mjs';
import {deliverWithRetryAndCleanup} from '../supabase/functions/_shared/push-delivery.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const order={id:'order-123',order_code:'ORD-123',buyer_id:'buyer',order_items:[{id:'item-platform',listing_id:'listing-a',listing_code:'AS-A',seller_id:'owner',owner_type:'platform',owner_vendor_id:null,delivery_type:'instant',gross:150000},{id:'item-vendor',listing_id:'listing-b',listing_code:'AS-B',seller_id:'vendor-a',owner_type:'vendor',owner_vendor_id:'vendor-a',delivery_type:'rental',gross:5000}]};

test('paid instant, assisted, rental and chat events target only order participants',()=>{
 assert.deepEqual(pushRecipients('instant_sale',{...order,order_items:[order.order_items[0]]},null,'owner'),['owner']);
 assert.deepEqual(pushRecipients('instant_sale',{...order,order_items:[order.order_items[1]]},null,'owner'),['vendor-a']);
 assert.deepEqual(pushRecipients('assisted_delivery',{...order,order_items:[order.order_items[1]]},null,'owner'),['vendor-a','owner']);
 assert.deepEqual(pushRecipients('rental_started',{...order,order_items:[order.order_items[1]]},null,'owner'),['vendor-a','owner']);
 assert.deepEqual(pushRecipients('chat_message',{...order,order_items:[order.order_items[1]]},'buyer','owner'),['vendor-a']);
 assert.deepEqual(pushRecipients('chat_message',{...order,order_items:[order.order_items[1]]},'vendor-a','owner'),['buyer']);
 assert.deepEqual(pushRecipients('chat_message',{...order,order_items:[order.order_items[1]],support_thread:true},'buyer','owner'),['vendor-a','owner']);
 for(const type of ['instant_sale','assisted_delivery','rental_started','rental_expiring','rental_expired'])assert.equal(pushRecipients(type,{...order,order_items:[{...order.order_items[1],owner_vendor_id:'unrelated'}]},null,'owner').includes('stranger'),false);
});

test('push copy never takes or includes chat body text and targets the relevant order or chat',()=>{
 const chat=pushCopy('chat_message',order);assert.equal(chat.body,'New message on Order ORD-123');assert.equal(JSON.stringify(chat).includes('secret message'),false);
 assert.match(pushCopy('instant_sale',order,order.order_items[0]).body,/New instant sale: AS-A · Order ORD-123 · ₦150,000/);
 assert.match(pushCopy('assisted_delivery',order,order.order_items[1]).body,/Order ORD-123 · Listing AS-B/);
 assert.equal(pushTarget('order-123',false),'./?screen=Orders&order_id=order-123');
 assert.equal(pushTarget('order-123',true),'./?screen=Orders&order_id=order-123&open_chat=1');
 assert.equal(pushTarget('order-123',false,'vendor','instant_sale'),'./?screen=Vendor&order_id=order-123&vendor_tab=Orders');
 assert.equal(pushTarget('order-123',false,'owner','instant_sale'),'./?screen=Admin&order_id=order-123&admin_tab=Sales');
});

test('gone subscription is deleted and transient failures receive at most two retries',async()=>{
 const removed=[];const result=await deliverWithRetryAndCleanup({id:'gone-id'},async()=>{throw {statusCode:410};},async id=>removed.push(id),async()=>{});
 assert.equal(result,'gone');assert.deepEqual(removed,['gone-id']);
 let attempts=0;const retried=await deliverWithRetryAndCleanup({id:'transient'},async()=>{attempts++;if(attempts<3)throw {statusCode:503};},async()=>{},async()=>{});
 assert.equal(retried,'sent');assert.equal(attempts,3);
 let permanentAttempts=0;const failed=await deliverWithRetryAndCleanup({id:'bad'},async()=>{permanentAttempts++;throw {statusCode:400};},async()=>{},async()=>{});
 assert.equal(failed,'failed');assert.equal(permanentAttempts,1);
});

test('push subscription and preferences tables enforce authenticated self access',async()=>{
 const sql=await read('../supabase/migrations/202611090003_push_notifications.sql');
 for(const table of ['push_subscriptions','push_preferences']){assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`));assert.match(sql,new RegExp(`user_id=auth\\.uid\\(\\)`));}
 assert.match(sql,/revoke all on public\.push_deliveries from anon,authenticated/);
});

test('service worker displays push and safely opens same-origin notification destinations without caching push data',async()=>{
 const source=await read('../service-worker.js'),listeners=new Map(),shown=[],opened=[],navigated=[];
 const client={url:'https://site.test/app/',navigate:async url=>navigated.push(url),focus:async()=>{}};
 const self={location:new URL('https://site.test/app/service-worker.js'),clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)},registration:{showNotification:async(title,options)=>shown.push({title,options})},addEventListener:(type,fn)=>listeners.set(type,fn)};
 vm.runInNewContext(source,{self,URL,Response,Promise,caches:{},fetch(){},console});
 let waited;listeners.get('push')({data:{json:()=>({title:'Sale',body:'Order update',url:'https://evil.test/steal'})},waitUntil:p=>waited=p});await waited;
 assert.equal(shown[0].title,'Sale');assert.equal(shown[0].options.body,'Order update');assert.equal(new URL(shown[0].options.data.url).origin,'https://site.test');
 listeners.get('notificationclick')({notification:{data:{url:'https://evil.test/steal'},close(){}},waitUntil:p=>waited=p});await waited;assert.deepEqual(opened,['https://site.test/app/']);
 assert.equal(source.includes("addEventListener('push'"),true);assert.equal(source.includes("addEventListener('notificationclick'"),true);assert.doesNotMatch(source,/push.{0,60}cache\.put|cache\.put.{0,60}push/i);
});

test('server-only sender has no endpoint or subscription key logging and triggers from payment and chat servers',async()=>{
 const fn=await read('../supabase/functions/send-push/index.ts'),payment=await read('../supabase/functions/payment-reconcile/index.ts'),webhook=await read('../supabase/functions/flutterwave-webhook/index.ts'),chat=await read('../supabase/functions/order-chat/index.ts'),upload=await read('../supabase/functions/order-chat-upload/index.ts');
 assert.match(fn,/SUPABASE_SERVICE_ROLE_KEY/);assert.match(fn,/VAPID_PRIVATE_KEY/);assert.match(fn,/VAPID_SUBJECT/);assert.doesNotMatch(fn,/console\.(?:log|error|warn)\([^\n]*(?:endpoint|p256dh|auth)/i);
 assert.match(payment,/event_type:'payment_confirmed'/);assert.match(webhook,/event_type:'payment_confirmed'/);assert.match(chat,/event_type:'chat_message'.*message_id/);assert.match(upload,/event_type:'chat_message'.*message_id/);
 for(const source of [chat,upload])assert.doesNotMatch(source,/sendPush\(\{[^}]*message(?:_text)?\s*:/s);
});

test('notification deep links preserve buyer, vendor and owner routes through app startup',async()=>{
 const app=await read('../src/main.js');
 assert.match(app,/if\(route==='Vendor'&&state\.role==='vendor'\)\{state\.screen='Vendor';state\.vendorTab=params\.get\('vendor_tab'\)\|\|'Orders';\}/);
 assert.match(app,/if\(route==='Admin'&&\['owner','admin'\]\.includes\(state\.role\)\)\{state\.screen='Admin';state\.adminTab=params\.get\('admin_tab'\)\|\|'Orders';\}/);
 assert.match(app,/if\(state\.screen==='home'\)setScreen\('Market'\);else render\(\);await handlePaymentReturn\(\);/);
});
