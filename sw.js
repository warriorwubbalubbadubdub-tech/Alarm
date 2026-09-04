// Minimal service worker for the Alarm PWA.
// Handles: offline caching + best-effort background alarm notification.
//
// IMPORTANT REALITY CHECK:
// Browsers do NOT allow web pages/service workers to run arbitrary timers
// in the background indefinitely (no background JS execution once the
// tab/app is fully closed and the OS suspends it). This service worker
// does its best using setTimeout while it is alive, and will show a
// system notification when the alarm fires IF the browser process for
// this PWA is still alive (e.g. app open, tab open, or recently backgrounded).
//
// For fully reliable alarms while the phone is locked/app closed, a native
// app would be required. Keeping the tab/app open (or your phone unlocked
// with the browser running) gives the most reliable results with this
// pure HTML+SW approach.

const CACHE_NAME = 'alarm-app-v1';
const STATE_CACHE_NAME = 'alarm-app-state-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './alarm.mp3'
];

let alarmTimeoutId = null;
let scheduledFireAt = null;

// Persist the scheduled fire time in Cache Storage (survives SW restarts,
// unlike a plain JS variable) so periodicsync can recover it even if the
// service worker process was killed and woken up fresh.
async function persistScheduledFireAt(fireAt){
  try{
    const cache = await caches.open(STATE_CACHE_NAME);
    if(fireAt === null){
      await cache.delete('/__alarm_state__');
    } else {
      await cache.put('/__alarm_state__', new Response(JSON.stringify({ fireAt })));
    }
  }catch(e){ /* ignore - best effort */ }
}

async function readPersistedFireAt(){
  try{
    const cache = await caches.open(STATE_CACHE_NAME);
    const res = await cache.match('/__alarm_state__');
    if(!res) return null;
    const data = await res.json();
    return typeof data.fireAt === 'number' ? data.fireAt : null;
  }catch(e){
    return null;
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(() => {
        // ignore individual cache failures (e.g. alarm.mp3 not yet added)
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  const keep = [CACHE_NAME, STATE_CACHE_NAME];
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => cached);
    })
  );
});

function clearScheduledAlarm(){
  if(alarmTimeoutId !== null){
    clearTimeout(alarmTimeoutId);
    alarmTimeoutId = null;
  }
  scheduledFireAt = null;
  persistScheduledFireAt(null);
  // Clear the "armed" notification if present
  self.registration.getNotifications({ tag: 'alarm-armed' }).then((notifs) => {
    notifs.forEach((n) => n.close());
  });
}

function scheduleAlarm(fireAt){
  clearScheduledAlarm();
  scheduledFireAt = fireAt;
  persistScheduledFireAt(fireAt);
  const delay = fireAt - Date.now();
  if(delay <= 0){
    fireAlarmNow();
    return;
  }
  // setTimeout in a service worker only reliably fires while the SW
  // is active. This is a best-effort mechanism — see note at top of file.
  alarmTimeoutId = setTimeout(fireAlarmNow, delay);

  // Show a low-key standing notification confirming the alarm is armed.
  // This does NOT make the alarm itself more reliable, but it means that
  // even if the timed trigger below gets killed by the OS, the person
  // still has visible proof (or lack of it) that something is scheduled,
  // rather than silent, invisible state.
  const target = new Date(fireAt);
  const timeStr = target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  self.registration.showNotification('Alarm armed', {
    body: 'Set for ' + timeStr + '. Keep the app open in the background for the most reliable ring.',
    tag: 'alarm-armed',
    silent: true,
    requireInteraction: false
  });
}

function fireAlarmNow(){
  alarmTimeoutId = null;
  scheduledFireAt = null;
  persistScheduledFireAt(null);

  self.registration.getNotifications({ tag: 'alarm-armed' }).then((notifs) => {
    notifs.forEach((n) => n.close());
  });

  // Try to notify any open page(s) first so they can play looping audio.
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
    clients.forEach((client) => {
      client.postMessage({ type: 'ALARM_FIRED' });
    });

    // Also show a system notification so the user is alerted even if
    // the app isn't in the foreground. Tapping it focuses/opens the app.
    self.registration.showNotification('Alarm', {
      body: 'Your alarm is ringing — tap to open.',
      tag: 'alarm-ring',
      requireInteraction: true,
      silent: false,
      vibrate: [500, 300, 500, 300, 500]
    });
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'ALARM_FIRED' });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./index.html');
      }
    })
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if(!data || !data.type) return;

  if(data.type === 'SCHEDULE_ALARM' && typeof data.fireAt === 'number'){
    scheduleAlarm(data.fireAt);
  } else if(data.type === 'CANCEL_ALARM'){
    clearScheduledAlarm();
  }
});

// Bonus wake mechanism: on browsers that grant Periodic Background Sync
// for installed PWAs, this lets the service worker check in periodically
// and fire the alarm if it's due, as a backup to the setTimeout above in
// case that got killed. Not supported on iOS Safari, and even on browsers
// that do support it, the OS decides exactly when (or whether) to run it.
self.addEventListener('periodicsync', (event) => {
  if(event.tag === 'alarm-check'){
    event.waitUntil((async () => {
      let target = scheduledFireAt;
      if(target === null){
        target = await readPersistedFireAt();
      }
      if(target !== null && Date.now() >= target){
        fireAlarmNow();
      }
    })());
  }
});

