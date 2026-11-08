import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const profile = join(root, `.pwa-audit-profile-${process.pid}`);
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const screenshots = [];
const errors = [];
let chrome;
let socket;
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

async function waitFor(predicate, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out waiting for Chrome DevTools');
}

async function evaluate(expression, awaitPromise = false) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
}

async function viewportAudit(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 600,
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await waitFor(() => evaluate("!!document.querySelector('.hero')"));
  await evaluate("document.querySelector('[data-nav=Market]').click()");
  await waitFor(() => evaluate("!!document.querySelector('.listing-grid .listing-card')"));
  const metrics = await evaluate(`(() => {
    const grid=document.querySelector('.listing-grid');
    const cards=[...document.querySelectorAll('.listing-card')];
    const first=cards[0],photo=first?.querySelector('.listing-image'),content=first?.querySelector('.listing-content');
    const buttons=[...first?.querySelectorAll('.listing-actions .button')||[]];
    return {
      viewport:innerWidth,
      documentWidth:document.documentElement.scrollWidth,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
      cards:cards.length,
      gridColumns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      gridGap:getComputedStyle(grid).columnGap,
      sidePadding:(innerWidth-document.querySelector('.app-shell').getBoundingClientRect().width)/2,
      shellWidth:getComputedStyle(document.querySelector('.app-shell')).width,
      mobileCss:matchMedia('(max-width:599px)').matches,
      photoHeight:Math.round(photo.getBoundingClientRect().height),
      photoFit:getComputedStyle(photo.querySelector('img')).objectFit,
      badgeFont:getComputedStyle(first.querySelector('.game-badge')).fontSize,
      priceFont:getComputedStyle(first.querySelector('.price')).fontSize,
      descriptionLines:getComputedStyle(first.querySelector('.description')).webkitLineClamp,
      touchButtonHeights:buttons.map(b=>Math.round(b.getBoundingClientRect().height)),
      bottomPadding:getComputedStyle(document.querySelector('.app-shell')).paddingBottom
    };
  })()`);
  metrics.flowLayer=await evaluate(`(async()=>{
    const scene=document.querySelector('.flow-scene'),back=scene?.querySelector('.flow-plane-back'),front=scene?.querySelector('.flow-plane-front'),card=document.querySelector('.listing-card');
    const before=back?.style.transform;await new Promise(resolve=>setTimeout(resolve,140));
    let motionUpdates=0;const observer=new MutationObserver(records=>motionUpdates+=records.filter(record=>record.target===back).length);observer.observe(back,{attributes:true,attributeFilter:['style']});await new Promise(resolve=>setTimeout(resolve,400));observer.disconnect();
    const rect=card?.getBoundingClientRect(),hit=rect?document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2):null;
    return {position:getComputedStyle(scene).position,zIndex:getComputedStyle(scene).zIndex,pointerEvents:getComputedStyle(scene).pointerEvents,contentZIndex:getComputedStyle(document.querySelector('#app')).zIndex,moved:before!==back?.style.transform,motionUpdatesIn400ms:motionUpdates,frontOpacity:getComputedStyle(front).opacity,listingIsAboveFlow:!!hit&&!hit.closest('.flow-scene'),transitionProperties:getComputedStyle(document.querySelector('.listing-card .button')).transitionProperty};
  })()`,true);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(root, `.pwa-audit-${width}.png`);
  writeFileSync(file, Buffer.from(screenshot.data, 'base64'));
  screenshots.push(file);

  if (width < 600) {
    const admin = await evaluate(`(() => {
      const node=document.createElement('nav');node.className='admin-sidebar glass';node.style.cssText='position:fixed;left:0;right:0;top:0;z-index:9999';
      ['Dashboard','Listings','Orders','Sales','Payouts','Users','Feature flags'].forEach(label=>{const b=document.createElement('button');b.className='admin-nav';b.textContent=label;node.append(b)});
      document.body.append(node);return {clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,labels:[...node.children].map(x=>({text:x.textContent,width:Math.round(x.getBoundingClientRect().width),scrollWidth:x.scrollWidth}))};
    })()`);
    metrics.adminTabsScroll = admin.scrollWidth > admin.clientWidth;
    metrics.adminLabels = admin.labels;
    await evaluate("document.querySelector('nav.admin-sidebar')?.remove()");
  }
  return metrics;
}

try {
  if (!profile.startsWith(root + sep)) throw new Error('Refusing to use an audit profile outside the app folder');
  mkdirSync(profile, { recursive: true });
  chrome = spawn(chromePath, [
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const activePortFile = join(profile, 'DevToolsActivePort');
  await waitFor(() => existsSync(activePortFile));
  const port = readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (packet.id && pending.has(packet.id)) {
      const entry = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) entry.reject(new Error(`${entry.method}: ${packet.error.message}`));
      else entry.resolve(packet.result || {});
    }
    if (packet.method === 'Runtime.exceptionThrown') errors.push(packet.params.exceptionDetails?.text || 'uncaught exception');
    if (packet.method === 'Runtime.consoleAPICalled' && packet.params.type === 'error') errors.push(packet.params.args?.map(arg => arg.value || arg.description || '').join(' '));
    if (packet.method === 'Log.entryAdded' && packet.params.entry.level === 'error') errors.push(packet.params.entry.text);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(window,'ARCADESTORE_CONFIG',{configurable:false,get:()=>({}),set:()=>{}});",
  });

  const mobile = await viewportAudit(390, 844);
  const desktop = await viewportAudit(1280, 900);
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reducedMotion=await evaluate(`(async()=>{const back=document.querySelector('.flow-plane-back');const before=back?.style.transform;await new Promise(resolve=>setTimeout(resolve,140));return {preference:matchMedia('(prefers-reduced-motion: reduce)').matches,heldStill:before===back?.style.transform}})()`,true);
  await send('Emulation.setEmulatedMedia',{features:[]});
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await waitFor(() => evaluate("!!document.querySelector('.hero')"));
  await waitFor(() => evaluate("!!document.querySelector('[data-action=signin]')"));
  const manifest = await send('Page.getAppManifest').catch(error => ({ protocolError: error.message }));
  const installability = await send('Page.getInstallabilityErrors').catch(error => ({ protocolError: error.message }));
  const pwa = await evaluate(`(async()=>{
    const manifestUrl=document.querySelector('link[rel=manifest]')?.href;
    const response=await fetch(manifestUrl);const manifest=await response.json();
    const icons=await Promise.all(manifest.icons.map(icon=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve({src:icon.src,width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>resolve({src:icon.src,error:true});image.src=icon.src})));
    const reg=await navigator.serviceWorker.ready;
    return {manifestUrl,status:response.status,name:manifest.name,shortName:manifest.short_name,startUrl:manifest.start_url,scope:manifest.scope,display:manifest.display,theme:manifest.theme_color,background:manifest.background_color,icons,swScope:reg.scope,swState:reg.active?.state,controlled:!!navigator.serviceWorker.controller};
  })()`, true);

  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await delay(900);
  const offline = await evaluate(`({noticeVisible:!document.querySelector('#offline-status')?.hidden,hasAppShell:!!document.querySelector('#app'),title:document.title,bodyText:document.body.innerText.slice(0,180)})`);

  console.log(JSON.stringify({ mobile, desktop, reducedMotion, manifestErrors: manifest.errors || manifest.protocolError || [], installability, pwa, offline, consoleErrors: errors, screenshots }, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch {}
  try {
    if (chrome && chrome.exitCode === null) {
      const stopped = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill();
      await Promise.race([stopped, delay(3000)]);
    }
  } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  if (process.env.KEEP_AUDIT_SCREENSHOTS !== '1') for (const screenshot of screenshots) try { rmSync(screenshot, { force: true }); } catch {}
}
