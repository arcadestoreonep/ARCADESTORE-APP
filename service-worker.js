const CACHE_NAME='arcade-store-shell-v1';
const SHELL_FILES=[
  './','./index.html','./offline.html','./styles.css','./config.js','./src/main.js','./manifest.json',
  './assets/arcade-mark.svg','./assets/icons/icon-192.png','./assets/icons/icon-512.png','./assets/icons/icon-maskable-512.png','./assets/icons/apple-touch-icon.png',
  './assets/backgrounds/arcade-emerald-flow.svg','./assets/backgrounds/clear-blue.jpg','./assets/backgrounds/emerald-light.jpg','./assets/backgrounds/emerald-wave.jpg','./assets/backgrounds/organic-green.jpg','./assets/backgrounds/purple-glow.jpg',
  './assets/games/bloodstrike.jpg','./assets/games/call-of-duty.jpg','./assets/games/free-fire.jpg'
];
const STATIC_URLS=new Set(SHELL_FILES.map(path=>new URL(path,self.location).href));
const API_PATH=/\/(?:auth\/v1|rest\/v1|functions\/v1|storage\/v1|graphql)(?:\/|$)/;

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll([...STATIC_URLS])).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('arcade-store-shell-')&&key!==CACHE_NAME).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||API_PATH.test(url.pathname))return;

  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(async()=>{
      const cache=await caches.open(CACHE_NAME);
      return await cache.match(new URL('./index.html',self.location).href)||await cache.match(new URL('./offline.html',self.location).href);
    }));
    return;
  }

  if(!STATIC_URLS.has(url.href))return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache=>{
    const cached=await cache.match(request);
    const update=fetch(request).then(response=>{
      if(response.ok&&response.type==='basic')cache.put(request,response.clone());
      return response;
    });
    if(cached){event.waitUntil(update.catch(()=>{}));return cached;}
    return await update.catch(()=>Response.error());
  }));
});
