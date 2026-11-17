// The web door's service worker: it shows what the resident pushes (src/web-push.ts) and opens the page when one is
// tapped. It keeps nothing offline; the page always comes from the Worker. Opened from the home screen with no
// network, the page is a short note that opens it again once the network is back, not the browser's error page.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    // The page is asked for while this worker starts, so it is no slower for going through it.
    self.registration.navigationPreload ? self.registration.navigationPreload.enable() : null
  ]));
});

const OFFLINE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>连不上</title>
<style>:root{color-scheme:dark;--bg:#070a16;--fg:#eef0ff;--dim:#9aa0c8}
:root[data-theme=light]{color-scheme:light;--bg:#F8F5EF;--fg:#232437;--dim:#5a5d82}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;text-align:center}
p{margin:0 0 4px}p+p{color:var(--dim);font-size:13px}
button{margin-top:18px;width:44px;height:44px;border-radius:50%;border:1px solid var(--dim);background:none;color:var(--fg);cursor:pointer}
svg{width:20px;height:20px;vertical-align:middle}</style>
<script>var t=null;try{t=localStorage.getItem('resident.theme')}catch(e){}
document.documentElement.dataset.theme=t==='light'||(t!=='dark'&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';
addEventListener('online',function(){location.reload()});</script></head>
<body><main><p>连不上网</p><p>网络回来了会自己打开</p>
<button type="button" onclick="location.reload()" title="再试一次" aria-label="再试一次"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/></svg></button>
</main></body></html>`;

// Only the page itself; everything else goes to the network as if there were no worker.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith((async () => {
    try {
      return (await event.preloadResponse) || (await fetch(event.request));
    } catch {
      return new Response(OFFLINE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // Every push is shown: Safari takes a push it is not shown as a reason to stop sending them.
  event.waitUntil(
    self.registration.showNotification(data.title || '住户', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'resident',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const page of pages) {
        // Not a page framed inside another site (the Mini App in Telegram's web app): open a window of its own.
        if (new URL(page.url).origin === self.location.origin && page.frameType !== 'nested' && 'focus' in page) {
          // An open page switches to the resident the notification is from (?r=<id>, src/residents.ts).
          page.postMessage({ open: url });
          return page.focus();
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});
