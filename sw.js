// Peakly Service Worker — handles push notification display and clicks

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/peakly.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('peakly') && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

// Triggered by main page via postMessage to show a notification
self.addEventListener('message', e => {
  if (e.data?.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, url } = e.data;
    self.registration.showNotification(title, {
      body,
      tag,
      icon: '/peakly-icon.png',
      badge: '/peakly-icon.png',
      data: { url: url || '/peakly-calendar.html' },
      requireInteraction: false,
      silent: false,
    });
  }
});

// Triggered by the server (send-due-notifications Edge Function) via the
// Web Push protocol — this fires even when no Peakly tab is open.
self.addEventListener('push', e => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch (err) { payload = { title: 'Peakly', body: e.data ? e.data.text() : '' }; }
  const title = payload.title || 'Peakly';
  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    icon: '/peakly-icon.png',
    badge: '/peakly-icon.png',
    data: { url: payload.url || '/peakly-calendar.html' },
    requireInteraction: false,
    silent: false,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Fires if the browser/OS invalidates the current push subscription — try to
// resubscribe with the same server key so notifications keep working.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(
    self.registration.pushManager.subscribe(e.oldSubscription ? { userVisibleOnly: true, applicationServerKey: e.oldSubscription.options.applicationServerKey } : undefined)
      .then(sub => {
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
          list.forEach(c => c.postMessage({ type: 'PUSH_RESUBSCRIBED', subscription: sub.toJSON() }));
        });
      })
      .catch(() => {})
  );
});
