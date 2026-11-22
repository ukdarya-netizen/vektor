/* Vektor service worker: shows push notifications and opens the terminal on click. */
self.addEventListener("push", (e) => {
  let d = { title: "Vektor", body: "" };
  try { d = e.data.json(); } catch { d.body = e.data ? e.data.text() : ""; }
  e.waitUntil(self.registration.showNotification(d.title || "Vektor", { body: d.body, icon: "favicon.svg", badge: "favicon.svg" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return self.clients.openWindow(self.registration.scope);
  }));
});
