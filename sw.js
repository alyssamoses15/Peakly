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
