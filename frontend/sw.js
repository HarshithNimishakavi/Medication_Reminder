self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || 'It is time for your medicine.' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Medi Remind', {
    body: data.body || 'It is time for your medicine.',
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: `medicine-${Date.now()}`,
    data: { url: data.url || '/patient.html', patientId: data.patientId, medicineId: data.medicineId, doseTime: data.doseTime },
    requireInteraction: true,
    actions: [
      { action: 'taken', title: 'I took it' },
      { action: 'later', title: 'Later' }
    ]
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'taken' || event.action === 'later') {
    event.waitUntil((async () => {
      const subscription = await self.registration.pushManager.getSubscription();
      await fetch('/api/push/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...event.notification.data, action: event.action, endpoint: subscription?.endpoint })
      });
    })());
    return;
  }
  const target = new URL(event.notification.data?.url || '/patient.html', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return self.clients.openWindow(target);
  }));
});
