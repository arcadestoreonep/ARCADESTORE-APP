import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const appRoot=fileURLToPath(new URL('../',import.meta.url));

async function applicationScripts(directory=appRoot){
 const files=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory()){
   if(['.git','node_modules','tests'].includes(entry.name)||entry.name.startsWith('.pwa-audit'))continue;
   files.push(...await applicationScripts(join(directory,entry.name)));
  }else if(/\.(?:js|mjs|cjs|html)$/i.test(entry.name))files.push(join(directory,entry.name));
 }
 return files;
}

test('no stale sectionOnly identifier remains in application JavaScript or inline HTML scripts',async()=>{
 const files=await applicationScripts();
 for(const file of files)assert.doesNotMatch(await readFile(file,'utf8'),/\bsectionOnly\b/,`${file} must not contain the stale identifier`);
});

test('auth renderer does not reference admin-only locals and admin partial rendering owns its content variable',async()=>{
 const app=await read('../src/main.js');
 const auth=app.slice(app.indexOf('function auth(){'),app.indexOf('function showSupport()'));
 assert.doesNotMatch(auth,/\b(?:sectionOnly|contentOnly|body)\b/);
 assert.match(app,/function adminScreen\(contentOnly=false\)[\s\S]*?if\(contentOnly\)return body;/);
});

test('landing buttons follow their expected delegated routes and UI errors stay friendly',async()=>{
 const app=await read('../src/main.js');
 assert.match(app,/data-nav="Market">Explore the store/);
 assert.match(app,/data-action="signin">Log in/);
 assert.match(app,/if\(t\.dataset\.nav\)\{await navTo\(t\.dataset\.nav\);/);
 assert.match(app,/if\(action==='signup'\|\|action==='signin'\)\{state\.authTab=action;setScreen\('auth'\);/);
 assert.match(app,/function navTo\(name\)[\s\S]*?state\.screen=name;render\(\)/);
 assert.match(app,/function reportActionError\(error\)\{const message=typeof error\?\.message/);
 assert.doesNotMatch(app,/That didn’t work\. Please try again\./);
 assert.doesNotMatch(app,/toast\(e\.message(?:\|\|[^)]*)?,'error'\)/);
});

test('recovery OTP length matches the live Supabase Auth configuration',async()=>{
 const app=await read('../src/main.js');
 const verify=await read('../supabase/functions/verify-otp/index.ts');
 const config=await read('../supabase/config.toml');
 assert.match(config,/otp_length\s*=\s*8/);
 assert.match(app,/const OTP_LENGTH=8/);
 assert.match(app,/Preview mode code: 00000000/);
 assert.match(app,/code!=='00000000'/);
 assert.match(app,/\^\\d\{8\}\$/);
 assert.match(verify,/\^\\d\{8\}\$/);
 assert.doesNotMatch(verify,/\^\\d\{6\}\$/);
});
