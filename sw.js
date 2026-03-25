self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'New item', {
      body: data.body || '',
      icon: data.icon || '',
      badge: data.icon || '',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url === event.notification.data.url && 'focus' in c) return c.focus();
      }
      return clients.openWindow(event.notification.data.url);
    })
  );
});
