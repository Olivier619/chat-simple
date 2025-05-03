// service-worker.js

console.log('Service Worker registered and running.');

// Écouteur pour l'événement 'push' (quand le serveur envoie une notification)
self.addEventListener('push', function(event) {
  console.log('[Service Worker] Push Received.');
  console.log(`[Service Worker] Push had this data: "${event.data.text()}"`);

  const title = 'Push Notification'; // Titre par défaut
  const options = {
    body: event.data.text() || 'No payload', // Contenu par défaut
    icon: 'icon.png' // Optionnel : chemin vers une icône
  };

  // Montrer la notification à l'utilisateur
  event.waitUntil(self.registration.showNotification(title, options));
});

// Écouteur pour l'événement 'notificationclick' (quand l'utilisateur clique sur la notification)
self.addEventListener('notificationclick', function(event) {
  console.log('[Service Worker] Notification click Received.');

  event.notification.close(); // Fermer la notification

  // Optionnel : Ouvrir une fenêtre ou un onglet du navigateur quand on clique
  // event.waitUntil(
  //   clients.openWindow('http://localhost:8080/') // Remplacez par l'URL de votre application
  // );
});

// Écouteur pour l'événement 'install'
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  // Permet au nouveau service worker de contrôler la page immédiatement
  self.skipWaiting();
});

// Écouteur pour l'événement 'activate'
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  // Revendiquer le contrôle des clients
  event.waitUntil(clients.claim());
});