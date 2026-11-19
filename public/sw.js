self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Medicine reminder", body: event.data.text() };
  }
  event.waitUntil(self.registration.showNotification(payload.title || "Medicine reminder", {
    body: payload.body || "It is time to take your medicine.",
    tag: payload.tag || "medicine-reminder",
    icon: "/medicine-icon.svg",
    badge: "/medicine-icon.svg",
    data: { url: payload.url || "/" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow(url);
  }));
});
