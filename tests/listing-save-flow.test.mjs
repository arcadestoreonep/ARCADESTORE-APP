import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {requireRole} from '../supabase/functions/_shared/core.mjs';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('listing editor has a separate draft path and does not hide failed saves',async()=>{
 const app=await read('../src/main.js');
 assert.match(app,/name="save_as_draft" value="true" formnovalidate>Save draft/);
 assert.match(app,/createListing\(event\.submitter\?\.value==='true'\)/);
 assert.match(app,/save_as_draft:saveAsDraft/);
 assert.match(app,/if\(!saveAsDraft\)await apiFunction\(endpoint,\{action:'publish_listing'/);
 assert.doesNotMatch(app,/new-listing-form'\)\{await createListing\([^;]*;f\.closest\('\.modal-backdrop'\)\?\.remove\(\)/);
 assert.match(app,/catch\(e\)\{reportActionError\(e\);return false;\}/);
});

test('save and publish actions match the deployed admin and vendor function contracts',async()=>{
 const app=await read('../src/main.js');
 const admin=await read('../supabase/functions/admin/index.ts');
 const vendor=await read('../supabase/functions/vendor/index.ts');
 for(const source of [admin,vendor]){
  assert.match(source,/data\.action==='create_listing'/);
  assert.match(source,/data\.action==='update_listing'/);
  assert.match(source,/data\.action==='publish_listing'/);
  assert.match(source,/save_as_draft===true/);
 }
 assert.match(app,/action,listing_id:listingId,save_as_draft:saveAsDraft,game:/);
 assert.match(app,/action:'publish_listing',listing_id:savedId/);
 assert.match(admin,/seller_id:user\.id,owner_type:'platform',owner_vendor_id:null/);
 assert.match(admin,/requireRole\(user,\['owner','admin'\]\)/);
 assert.match(vendor,/requireRole\(user,\['vendor'\]\)/);
});

test('buyer roles cannot enter the admin listing create or publish path',async()=>{
 const buyer={id:'buyer-test',app_metadata:{role:'buyer'}};
 const owner={id:'owner-test',app_metadata:{role:'owner'}};
 assert.throws(()=>requireRole(buyer,['owner','admin']),/forbidden/);
 assert.equal(requireRole(owner,['owner','admin']),'owner');
 const admin=await read('../supabase/functions/admin/index.ts');
 assert.match(admin,/const \{user\}=await identity\(req\),role=requireRole\(user,\['owner','admin'\]\)/);
});

test('draft configuration permits empty credentials only for drafts, publish still requires credentials',async()=>{
 const shared=await read('../supabase/functions/_shared/listings.mjs');
 const migration=await read('../supabase/migrations/202611100001_allow_empty_credentials_on_drafts.sql');
 const admin=await read('../supabase/functions/admin/index.ts');
 assert.match(shared,/allowEmptyCredentials&&Array\.isArray\(credentials\)&&credentials\.length===0/);
 assert.match(migration,/jsonb_array_length\(p_credentials\)=0[\s\S]*status='draft'/);
 assert.match(admin,/if\(!count&&!legacy\)throw new Error\('Add at least one credential before publishing this listing\.'/);
});

test('listing console query includes drafts and renderer prints each returned status',async()=>{
 const app=await read('../src/main.js');
 const admin=await read('../supabase/functions/admin/index.ts');
 assert.match(admin,/from\('listings'\)\.select\([^;]+\.neq\('status','deleted'\)/);
 assert.match(app,/state\.adminListings\.map\(l=>[\s\S]*?esc\(l\.status\)/);
 assert.match(app,/No listings yet\./);
});

test('admin listing actions keep the listing id and do not inject malformed buttons',async()=>{
 const app=await read('../src/main.js');
 assert.doesNotMatch(app,/body=body\.replaceAll\(['"]<div class="button-row admin-listing-actions/);
 assert.match(app,/data-action="publish-listing" data-id="\$\{esc\(l\.id\)\}"/);
 assert.match(app,/t\.dataset\.id\|\|t\.closest\('\[data-listing-id\]'\)\?\.dataset\.listingId/);
 const start=app.indexOf('function adminScreen('),end=app.indexOf('function vendorScreen(',start);
 assert.ok(start>=0&&end>start,'admin renderer source is present');
 const render=new Function('state','nav','esc','money','shortOrderId','appHeader',`${app.slice(start,end)};return adminScreen(true);`);
 const html=render({role:'owner',adminTab:'Listings',flags:{admin_publishing:true},adminListings:[{id:'listing-test-id',listing_code:'ACCT-1',game:'Bloodstrike',price:10000,status:'draft',description:'Test listing'}]}, {hidden:false},String,value=>String(value),()=>'',()=> '');
 assert.match(html,/<button class="button button-small" data-action="publish-listing" data-id="listing-test-id">Publish<\/button>/);
 assert.match(html,/<button class="button button-small" data-action="edit-listing">Edit<\/button>/);
 assert.doesNotMatch(html,/data-id="<button/);
});

test('payout UI is removed from the admin console and no payout refresh blocks listings',async()=>{
 const app=await read('../src/main.js');
 assert.doesNotMatch(app,/state\.adminTab==='Payouts'|data-action="check-payout"|id="bank-details-form"|id="cashout-form"/);
 assert.doesNotMatch(app,/apiFunction\('payouts'/);
 assert.doesNotMatch(app,/apiFunction\('admin',\{action:'dashboard'/);
 assert.doesNotMatch(app,/Available balance|state\.balance/);
 assert.match(app,/if\(!tabs\.includes\(state\.adminTab\)\)state\.adminTab='Dashboard'/);
});

test('server errors keep actionable reasons while browser logs only action, status, and code',async()=>{
 const app=await read('../src/main.js');
 const server=await read('../supabase/functions/_shared/server.ts');
 const listings=await read('../supabase/functions/_shared/listings.mjs');
 assert.match(server,/json\(\{error:text,code\},status\)/);
 assert.match(app,/payload\.error\|\|payload\.message\|\|data\?\.error/);
 assert.match(app,/console\.error\('\[Arcade Store\] Edge Function request failed',\{function:name,action,status,errorCode\}\)/);
 assert.doesNotMatch(app,/console\.error\([^\n]*(?:credentials|requestBody|body\.credentials)/i);
 assert.match(app,/function reportActionError\(error\)\{const message=typeof error\?\.message/);
 assert.doesNotMatch(app,/That didn’t work\. Please try again\./);
 assert.match(listings,/const failure=new Error\(message\);failure\.code=code/);
});
