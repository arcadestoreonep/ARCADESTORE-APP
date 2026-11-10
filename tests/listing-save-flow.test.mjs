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

test('new listing draft starts with an empty credential row accepted by the draft path',async()=>{
 const app=await read('../src/main.js');
 assert.match(app,/credentials=existing\.credentials\?\.length\?existing\.credentials:\[\{label:'',value:''\}\]/);
 const start=app.indexOf('function collectCredentialEntries(form){');
 const end=app.indexOf('\nfunction rentalOptionRow(',start);
 assert.ok(start>=0&&end>start,'credential collector is present');
 const collect=new Function(`${app.slice(start,end)};return collectCredentialEntries;`)();
 const blankRow={querySelector:selector=>({value:''})};
 assert.deepEqual(collect({querySelectorAll:()=>[blankRow]}),[]);
 const filledRow={querySelector:selector=>({value:selector.includes('label')?'Game login':'player@example.test'})};
 assert.deepEqual(collect({querySelectorAll:()=>[filledRow]}),[{label:'Game login',value:'player@example.test'}]);
});

test('saving a blank-credential draft sends the draft payload and does not publish it',async()=>{
 const app=await read('../src/main.js');
 const start=app.indexOf('async function createListing(saveAsDraft=false){');
 const end=app.indexOf('\n function newListingModal(',start);
 assert.ok(start>=0&&end>start,'createListing source is present');
 const blankRow={querySelector:()=>({value:''})};
 const calls=[],errors=[];
 const form={reportValidity:()=>true,elements:{photo:{files:[]}},dataset:{listingId:''},querySelectorAll:()=>[blankRow],closest:()=>({remove(){}})};
 const data={game:'Bloodstrike',price:'10000',description:'A complete account listing.',delivery_type:'instant',transfer_instructions:''};
 class FakeFormData{get(key){return data[key]??null;}}
 const state={backend:true,role:'owner',user:{id:'owner-test'},adminTab:'Dashboard'};
 const run=new Function('state','document','FormData','collectCredentialEntries','apiFunction','refreshMarket','refreshVendorData','refreshAdminData','render','toast','reportActionError',`${app.slice(start,end)};return createListing;`)(state,{querySelector:()=>form},FakeFormData,()=>[],async(_name,payload)=>{calls.push(payload);return{listing_id:'draft-test'};},async()=>{},async()=>{},async()=>{},()=>{},()=>{},error=>errors.push(error));
 assert.equal(await run(true),true);
 assert.equal(calls.length,1);
 assert.equal(calls[0].action,'create_listing');
 assert.equal(calls[0].save_as_draft,true);
 assert.deepEqual(calls[0].credentials,[]);
 assert.equal(calls.some(call=>call.action==='publish_listing'),false);
 assert.deepEqual(errors,[]);
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
 assert.match(html,/<button class="button button-small" data-action="edit-listing" data-id="listing-test-id">Edit<\/button>/);
 assert.doesNotMatch(html,/data-id="<button/);
});

test('publish, pause, and delete are sent by exactly one delegated handler',async()=>{
 const app=await read('../src/main.js');
 assert.equal((app.match(/if\(\['publish-listing','hide-listing','delete-listing'\]\.includes\(action\)\)/g)||[]).length,1);
 assert.doesNotMatch(app,/const endpointAction=action==='publish-listing'\?/);
});

test('admin data refresh loads only the selected section and keeps secondary endpoints from hiding listings',async()=>{
 const app=await read('../src/main.js');
 assert.match(app,/const requiredAction=tab==='Listings'\?'list_listings':tab==='Orders'\?'list_orders':tab==='Sales'&&state\.role==='owner'\?'list_sales':tab==='Users'&&state\.role==='owner'\?'list_admins':null/);
 assert.match(app,/const actions=tab==='Dashboard'\?\['list_listings','list_orders'\]:requiredAction\?\[requiredAction\]:\[\]/);
 assert.match(app,/Promise\.allSettled\(actions\.map\(action=>apiFunction\('admin',\{action\}\)\)\)/);
 assert.match(app,/if\(requiredError\)throw requiredError/);
 assert.match(app,/if\(state\.backend\)refreshAdminData\(\)\.then\(/);
});

test('opening Listings requests only list_listings and preserves its returned rows',async()=>{
 const app=await read('../src/main.js');
 const start=app.indexOf('async function refreshAdminData(){');
 const end=app.indexOf('\nasync function signin(',start);
 assert.ok(start>=0&&end>start,'refreshAdminData source is present');
 const refresh=new Function('state','apiFunction','reportActionError',`${app.slice(start,end)};return refreshAdminData;`);
 const state={backend:true,role:'owner',adminTab:'Listings',adminListings:[]},actions=[];
 const load=refresh(state,async(_name,body)=>{actions.push(body.action);return{listings:[{id:'draft-1',status:'draft'}]};},()=>{});
 await load();
 assert.deepEqual(actions,['list_listings']);
 assert.deepEqual(state.adminListings,[{id:'draft-1',status:'draft'}]);
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
