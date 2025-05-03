// server.js

const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose(); // Importer la bibliothèque SQLite
const webpush = require('web-push'); // *** NOUVEAU : Importer web-push ***


const port = 8080;
const dbFileName = 'chat.db'; // Nom du fichier de base de données SQLite

// Liste des conversations prédéfinies (ces IDs seront utilisés dans la DB)
// Ces conversations existent dès le premier lancement si la DB est vide.
const predefinedConversations = ['general', 'amis-secrets', 'projet-alpha'];


// Listes initiales des utilisateurs autorisés par conversation (pour peupler la DB la première fois)
// Après le premier lancement, la source de vérité sera la table AllowedUsers dans chat.db
const initialAllowedUsers = {
    'general': ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'TestUser1', 'TestUser2'],
    'amis-secrets': ['Alice', 'Bob'],
    'projet-alpha': ['Charlie', 'David']
    // Si une conversation n'est pas listée ici dans initialAllowedUsers, elle commencera vide.
    // Si un utilisateur n'est pas dans AllowedUsers pour une conversation, il ne pourra pas la rejoindre.
};

// *** NOUVEAU : Clés VAPID (REMPLACEZ PAR VOS CLÉS GÉNÉRÉES ET VOTRE EMAIL) ***
// Utilisez la commande 'npx web-push generate-vapid-keys' dans votre terminal.
const vapidKeys = {
    publicKey: 'BCo-UoFBid-ZqwWALM3ng33rAeT4rn_vu1aDRE9SQSjGFepaWgJqqsvAn8ypvPt7Y4stv8O_JiiAbkvNBQBesFk', // Ex: 'BXXXXXXXXXXXXXXXX...'
    privateKey: 'zQUQEgT10v8SV60777VjnT0adnpuTjHr-O85nfhkWH0', // Ex: 'YXXXXXXXXXXXXXXXX...'
};

// Configurer web-push avec les clés VAPID
webpush.setVapidDetails(
    'mailto:olivierlerch@sunrise.ch', // Remplacez par votre adresse e-mail
    vapidKeys.publicKey,
    vapidKeys.privateKey
);


// 1. Initialiser la base de données
let db;

function initializeDatabase() {
  db = new sqlite3.Database(dbFileName, (err) => {
    if (err) {
      console.error('Erreur lors de l\'ouverture de la base de données', err.message);
    } else {
      console.log('Connecté à la base de données SQLite.');

      // *** Créer la table 'messages' (vérifier conversation_id) ***
      db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT, -- Colonne pour l'ID de conversation
        user TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, function(createErr) { // Utilisation de function() pour accéder à this.lastID (pas utilisé ici mais bonne pratique)
        if (createErr) {
          console.error('Erreur lors de la création de la table messages', createErr.message);
          // Tenter d'ajouter la colonne si la table existe mais sans elle (logique simplifiée)
           db.get("SELECT sql FROM sqlite_master WHERE name='messages'", (pragmaErr, rowSql) => {
               if (pragmaErr || !rowSql || (rowSql.sql && !rowSql.sql.includes('conversation_id'))) {
                    console.warn("Table 'messages' existe sans 'conversation_id'. Tentative d'ALTER TABLE...");
                     db.run(`ALTER TABLE messages ADD COLUMN conversation_id TEXT`, (alterErr) => {
                        if(alterErr) {
                            console.error('Échec de l\'ajout de la colonne conversation_id', alterErr.message);
                        } else {
                            console.log('Colonne conversation_id ajoutée à la table messages.');
                        }
                         console.log('Table messages vérifiée/créée.');
                    });
               } else {
                   console.log('Table messages vérifiée/créée (avec conversation_id).');
               }
           });
        } else {
          console.log('Table messages vérifiée/créée (avec conversation_id).');
        }
      });

      // *** Créer la table 'Conversations' ***
      db.run(`CREATE TABLE IF NOT EXISTS Conversations (
        id TEXT PRIMARY KEY, -- L'ID de la conversation (ex: 'general')
        admin_user TEXT -- Le nom de l'utilisateur qui est l'administrateur (peut être NULL au début)
        -- On pourrait ajouter d'autres colonnes ici plus tard (nom affiché, etc.)
      )`, function(createConvErr) {
          if(createConvErr) {
              console.error('Erreur lors de la création de la table Conversations', createConvErr.message);
          } else {
              console.log('Table Conversations vérifiée/créée.');
               // *** Insérer les conversations prédéfinies si elles n'existent pas ***
               // Ceci assure qu'une entrée existe pour chaque predefinedConversation et qu'on peut y lier un admin.
               const stmt = db.prepare("INSERT OR IGNORE INTO Conversations (id, admin_user) VALUES (?, NULL)"); // Admin est NULL par défaut
               predefinedConversations.forEach(convId => {
                   stmt.run(convId, (insertErr) => {
                       if(insertErr) console.error(`Erreur insertion conversation initiale ${convId}`, insertErr.message);
                   });
               });
               stmt.finalize();
               console.log('Conversations prédéfinies vérifiées/ajoutées dans la base.');
          }
      });

       // *** Créer la table 'AllowedUsers' ***
       // Elle stocke explicitement quels utilisateurs sont autorisés dans quelles conversations.
       // Cela remplace la liste statique allowedUsers pour la persistence et permet l'ajout/suppression par admin.
       db.run(`CREATE TABLE IF NOT EXISTS AllowedUsers (
           conversation_id TEXT,
           user_name TEXT,
           PRIMARY KEY (conversation_id, user_name), -- Un utilisateur n'est autorisé qu'une fois par conversation
           FOREIGN KEY (conversation_id) REFERENCES Conversations(id) ON DELETE CASCADE
           -- Note: user_name devrait idéalement être une FK vers une table Users, mais nous n'avons pas de table Users pour l'instant.
       )`, function(createAllowedErr) {
           if(createAllowedErr) {
               console.error('Erreur lors de la création de la table AllowedUsers', createAllowedErr.message);
           } else {
               console.log('Table AllowedUsers vérifiée/créée.');
               // Optionnel : Peupler la table AllowedUsers avec les listes statiques initiales si elle est vide
               db.get("SELECT COUNT(*) as count FROM AllowedUsers", (countErr, row) => {
                   if (countErr) console.error("Erreur lors du comptage de AllowedUsers", countErr);
                   else if (row && row.count === 0) {
                       console.log("Table AllowedUsers vide. Peuplement initial...");
                       const stmt = db.prepare("INSERT OR IGNORE INTO AllowedUsers (conversation_id, user_name) VALUES (?, ?)");
                       for (const convId in initialAllowedUsers) {
                           if (initialAllowedUsers.hasOwnProperty(convId) && predefinedConversations.includes(convId)) {
                               initialAllowedUsers[convId].forEach(userName => { // <-- Utilise initialAllowedUsers
                                   stmt.run(convId, userName);
                               });
                           }
                       }
                       stmt.finalize();
                       console.log("Peuplement initial de AllowedUsers terminé.");
                   } else {
                       console.log("Table AllowedUsers déjà peuplée ou erreur de comptage.");
                   }
               });
           }
       });

       // *** NOUVEAU : Créer la table 'Subscriptions' pour stocker les abonnements Push ***
       db.run(`CREATE TABLE IF NOT EXISTS Subscriptions (
           user_name TEXT PRIMARY KEY, -- Un abonnement par utilisateur pour simplifier
           subscription TEXT NOT NULL -- Le JSON de l'abonnement
           -- user_name devrait idéalement être une FK vers une table Users, mais nous n'avons pas de table Users.
           -- PRIMARY KEY ici force un seul abonnement par user_name,simplifiant la logique.
       )`, function(createSubErr) {
           if(createSubErr) {
               console.error('Erreur lors de la création de la table Subscriptions', createSubErr.message);
           } else {
               console.log('Table Subscriptions vérifiée/créée.');
           }
       });


    }
  });
}

// Appeler l'initialisation au démarrage du script
initializeDatabase();


const server = http.createServer((req, res) => {
  // Ce serveur HTTP n'a pas de contenu web à servir pour l'instant,
  // il sert principalement de support pour le serveur WebSocket.
  // Le client HTML est ouvert directement depuis le fichier.
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Serveur de chat simple en cours d\'exécution.');
});

const wss = new WebSocket.Server({ server });

// Gérer les clients par conversation active
const clientsByConversation = new Map(); // Map<conversationId, Set<WebSocket>>
// Suivre les utilisateurs qui tapent par conversation
const typingUsersByConversation = new Map(); // Map<conversationId, Set<userName>>


// Fonction pour obtenir et diffuser la liste des utilisateurs connectés DANS une conversation
function broadcastUserList(conversationId) {
    // S'assurer que la conversation existe et a des clients actifs
    if (!clientsByConversation.has(conversationId)) {
        return; // Aucune raison de diffuser si personne n'est là
    }

    const clientsInConversation = clientsByConversation.get(conversationId);

    // Récupérer les noms de tous les clients DANS CETTE CONVERSATION qui se sont identifiés
    const users = Array.from(clientsInConversation) // Convertir le Set en Array
                       .filter(client => client.readyState === WebSocket.OPEN && client.userName) // Filtrer les clients ouverts et identifiés
                       .map(client => client.userName); // Extraire juste le nom

    // Créer le message JSON à envoyer
    const userListMessage = {
        type: 'userList',
        conversationId: conversationId, // Inclure l'ID de conversation
        users: users
    };

    // Diffuser cette liste UNIQUEMENT aux clients DANS CETTE CONVERSATION
    clientsInConversation.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(userListMessage));
        }
    });
    console.log(`Liste des utilisateurs connectés diffusée pour conversation "${conversationId}" :`, users);
}

// Fonction pour diffuser un message (chat, system, typing, etc.) à tous les clients DANS une conversation
function broadcastMessageToConversation(conversationId, message) {
     // S'assurer que la conversation existe et a des clients actifs
     if (!clientsByConversation.has(conversationId)) {
         // console.warn(`Attempted to broadcast to conversation "${conversationId}" with no active clients.`);
         return; // Personne à qui l'envoyer
     }

     const clientsInConversation = clientsByConversation.get(conversationId);

     clientsInConversation.forEach((client) => {
         if (client.readyState === WebSocket.OPEN) {
             client.send(JSON.stringify(message)); // Envoyer l'objet JSON directement
         }
     });
}

// Fonction pour diffuser la liste des utilisateurs qui tapent
function broadcastTypingStatus(conversationId) {
    const typingUsersSet = typingUsersByConversation.get(conversationId) || new Set();
    const typingUsersArray = Array.from(typingUsersSet); // Convertir en tableau

    const typingStatusMessage = {
        type: 'typingStatus',
        conversationId: conversationId,
        typingUsers: typingUsersArray
    };

    // Diffuser ce statut UNIQUEMENT aux clients DANS CETTE CONVERSATION
    broadcastMessageToConversation(conversationId, typingStatusMessage);

    // console.log(`Statut de frappe diffusé pour conv "${conversationId}" :`, typingUsersArray); // Moins verbeux
}

// Envoyer la liste des utilisateurs AUTORISÉS pour une conversation à un client spécifique
function sendAllowedUsersList(ws, conversationId) {
     // Ne devrait être appelé que si le client est l'admin de cette conversation,
     // mais la vérification peut être faite ici aussi par sécurité.
     if (!ws || !conversationId) {
         console.warn('sendAllowedUsersList called with missing arguments');
         return;
     }
     // Optionnel : ajouter ici une vérification que ws.userName est l'admin de conversationId en DB (déjà fait dans requestAllowedUsers)

    db.all(`SELECT user_name FROM AllowedUsers WHERE conversation_id = ? ORDER BY user_name ASC`, [conversationId], (err, rows) => {
        if (err) {
            console.error(`Erreur DB lors de la lecture des utilisateurs autorisés pour ${conversationId}`, err.message);
            ws.send(JSON.stringify({ type: 'error', text: 'Erreur lors du chargement de la liste des utilisateurs autorisés.' }));
        } else {
            const authorizedUsers = rows.map(row => row.user_name);
            console.log(`Envoi de la liste de ${authorizedUsers.length} utilisateurs autorisés pour conv "${conversationId}" à ${ws.userName}.`);
            // Envoyer la liste au client qui l'a demandée
            ws.send(JSON.stringify({
                type: 'allowedUsersList', // Nouveau type de message
                conversationId: conversationId,
                users: authorizedUsers
            }));
        }
    });
}


wss.on('connection', (ws) => {
  console.log('Client connecté');

  ws.userName = null; // Propriété pour stocker le nom de l'utilisateur
  ws.activeConversationId = null; // Conversation active du client
  ws.isAdminOfActiveConversation = false; // Statut admin local pour la conv active


  // Envoyer un message de bienvenue initial au client.
  // C'est à la réception de ce message (et confirmation de connexion) que le client demandera le nom.
  ws.send(JSON.stringify({ type: 'system', text: 'Bienvenue sur le serveur de chat simple ! Veuillez définir votre nom en entrant un nom quand demandé.' }));


  // 6. Gérer les messages reçus d'un client
  ws.on('message', (message) => {
    const messageString = message.toString();
    // console.log(`Reçu du client : ${messageString}`); // Moins verbeux pour le chat

    let parsedMessage;
    try {
      // Tenter de parser le message comme du JSON
      parsedMessage = JSON.parse(messageString);
    } catch (error) {
      console.error('Erreur lors du parsing JSON du message :', error);
      ws.send(JSON.stringify({ type: 'error', text: 'Format de message invalide (doit être JSON).' }));
      return; // Arrêter le traitement de ce message
    }

    // Gérer les différents types de messages
    switch (parsedMessage.type) {
      case 'setName':
        // Le client envoie son nom
        if (parsedMessage.name && typeof parsedMessage.name === 'string' && parsedMessage.name.trim().length > 0) {
           const oldName = ws.userName; // Garder l'ancien nom si l'utilisateur change de nom
           ws.userName = parsedMessage.name.trim().substring(0, 20); // Nettoyer et limiter la longueur

           console.log(`Client ${ws._socket.remoteAddress} s'est identifié comme : ${ws.userName}`);

           ws.send(JSON.stringify({ type: 'system', text: `Vous êtes maintenant connu sous le nom de "${ws.userName}".` }));

           // Si l'utilisateur change de nom alors qu'il est dans une conversation
            if (ws.activeConversationId && oldName !== ws.userName) {
                // On devrait idéalement mettre à jour son nom dans la liste AllowedUsers et Conversations (si admin)
                // et re-diffuser la liste d'utilisateurs. Pour l'instant, on log un warning et rediffuse la liste.
                console.warn(`Nom d'utilisateur changé de "${oldName}" à "${ws.userName}" en étant connecté. Peut causer des inconsistances.`);
                 broadcastUserList(ws.activeConversationId); // Rediffuser avec le nouveau nom (dans la liste des connectés en temps réel)
                 // NOTE: Les messages stockés en DB resteront avec l'ancien nom.
                 // Si l'utilisateur était admin, le nom d'admin dans Conversations restera l'ancien nom en DB jusqu'à ce qu'un nouveau devienne admin.
            }

           // *** NOUVEAU : MAINTENANT qu'on connaît le nom, envoyer la liste filtrée des conversations ***
           // Sélectionner les conversations où l'utilisateur est autorisé
           db.all(`SELECT conversation_id FROM AllowedUsers WHERE user_name = ?`, [ws.userName], (err, rows) => {
               if (err) {
                   console.error(`Erreur DB lors de la récupération convs autorisées pour ${ws.userName}`, err.message);
                   ws.send(JSON.stringify({ type: 'error', text: 'Erreur lors du chargement de vos conversations.' }));
               } else {
                   // authorizedConversations contient les IDs des conversations où l'utilisateur est autorisé.
                   // On filtre pour s'assurer que ce sont bien des IDs de conversations qui existent (même si elles ne sont pas prédéfinies, elles doivent exister en DB)
                   const authorizedConversations = rows.map(row => row.conversation_id);
                   console.log(`Envoi de la liste de ${authorizedConversations.length} conversations autorisées à ${ws.userName}.`);
                   // Le client affichera les boutons pour ces IDs.
                   ws.send(JSON.stringify({ type: 'availableConversations', conversations: authorizedConversations }));
               }
           });


        } else {
           ws.send(JSON.stringify({ type: 'error', text: 'Nom d\'utilisateur non valide.' }));
        }
        break;

      // Gérer le message pour rejoindre une conversation, vérifier l'autorisation et attribuer l'admin
      case 'joinConversation':
           if (!ws.userName) {
               ws.send(JSON.stringify({ type: 'system', text: 'Veuillez définir votre nom d\'utilisateur avant de rejoindre une conversation.' }));
               return;
           }
           if (!parsedMessage.conversationId || typeof parsedMessage.conversationId !== 'string') {
               ws.send(JSON.stringify({ type: 'error', text: 'ID de conversation invalide.' }));
               return;
           }
           const requestedConversationId = parsedMessage.conversationId;

           // Vérifier si la conversation existe en base (elle devrait être dans la table Conversations)
           db.get(`SELECT id FROM Conversations WHERE id = ?`, [requestedConversationId], (err, rowConv) => {
               if (err || !rowConv) {
                    console.error(`Erreur DB ou Conversation "${requestedConversationId}" non trouvée lors de la tentative de jonction.`, err);
                    ws.send(JSON.stringify({ type: 'error', text: `Conversation "${requestedConversationId}" non trouvée.` }));
                    return; // Sort du callback
               }

               // *** Logique d'autorisation et d'attribution d'admin dynamique (imbriquée) ***

               // 1. Vérifier si l'utilisateur est autorisé dans la table AllowedUsers pour cette conversation
               db.get(`SELECT 1 FROM AllowedUsers WHERE conversation_id = ? AND user_name = ?`, [requestedConversationId, ws.userName], (authErr, rowAuth) => {
                   if (authErr) {
                       console.error(`Erreur DB lors de la vérification autorisation ${ws.userName} dans ${requestedConversationId}`, authErr.message);
                       ws.send(JSON.stringify({ type: 'error', text: 'Erreur serveur lors de la vérification de l\'autorisation.' }));
                       return; // Sort du callback
                   }

                   const isAllowed = !!rowAuth; // True si une ligne est trouvée, False sinon

                   if (!isAllowed) {
                       console.warn(`Accès refusé pour ${ws.userName} à la conversation "${requestedConversationId}". Nom non trouvé dans la liste autorisée (DB).`);
                        ws.send(JSON.stringify({ type: 'system', text: `Votre nom ("${ws.userName}") n\'est pas autorisé à rejoindre la conversation "${requestedConversationId}".` }));
                        return; // Arrête le traitement ici dans le callback
                   }

                   // Si l'utilisateur est autorisé, procéder à la jonction et vérifier/attribuer l'admin

                   // 2. Vérifier/attribuer l'administrateur dans la table Conversations
                   db.get(`SELECT admin_user FROM Conversations WHERE id = ?`, [requestedConversationId], (adminErr, rowAdmin) => {
                       if (adminErr) {
                           console.error(`Erreur DB lors de la récupération admin pour ${requestedConversationId}`, adminErr.message);
                           ws.send(JSON.stringify({ type: 'error', text: 'Erreur serveur lors de la récupération des informations de conversation.' }));
                           return; // Sort du callback
                       }

                       let currentAdmin = rowAdmin ? rowAdmin.admin_user : null;
                       let isAdminOfThisConv = false;

                       // Si aucun admin n'est encore défini POUR CETTE CONVERSATION
                       if (!currentAdmin) {
                           // Tentative de devenir l'administrateur
                           db.run(`UPDATE Conversations SET admin_user = ? WHERE id = ? AND admin_user IS NULL`, [ws.userName, requestedConversationId], function(updateErr) { // Utilisation de function() pour this.changes
                               if (updateErr) {
                                   console.error(`Échec tentative attribution admin ${ws.userName} à ${requestedConversationId}`, updateErr.message);
                                   // On ne peut pas garantir qu'il est admin, on continue mais sans le statut admin
                               } else if (this.changes > 0) { // Si la mise à jour a affecté 1 ligne (car admin_user ÉTAIT NULL)
                                   console.log(`${ws.userName} est devenu l'administrateur de "${requestedConversationId}".`);
                                   currentAdmin = ws.userName; // Mettre à jour la variable locale
                                   isAdminOfThisConv = true; // Il est devenu l'admin
                               } else { // Si changes === 0, cela signifie qu'un autre client est devenu admin juste avant nous
                                    console.log(`Admin déjà défini pour "${requestedConversationId}", ${ws.userName} ne devient pas admin.`);
                                    // On doit relire qui est l'admin actuel pour l'envoyer au client
                                    db.get(`SELECT admin_user FROM Conversations WHERE id = ?`, [requestedConversationId], (err, row) => {
                                         if (row) currentAdmin = row.admin_user; // Mettre à jour currentAdmin avec le vrai admin
                                    });
                               }

                                // *** Continuer la logique de jonction après la tentative d'attribution admin ***
                                // (Ce bloc est exécuté après le db.run du UPDATE)
                                // Utiliser setTimeout 0 pour sortir du callback run et ne pas bloquer
                                setTimeout(() => {
                                    continueJoinLogic(ws, requestedConversationId, currentAdmin, isAdminOfThisConv);
                                }, 0);


                           }); // Fin du callback db.run pour l'attribution admin
                       } else { // Si currentAdmin existait déjà (lu au début du 2. callback)
                            // L'admin existait déjà, l'utilisateur actuel ne devient pas admin
                            // Vérifier si l'utilisateur actuel EST l'admin existant
                            if (currentAdmin === ws.userName) {
                                 isAdminOfThisConv = true; // L'utilisateur est l'admin existant
                                 console.log(`${ws.userName} (admin existant) a rejoint la conversation "${requestedConversationId}".`);
                            } else {
                                 console.log(`${ws.userName} a rejoint la conversation "${requestedConversationId}". Admin existant: ${currentAdmin}`);
                            }

                           // *** Continuer la logique de jonction après la vérification d'admin existant ***
                           // (Ce bloc est exécuté immédiatement car il n'y a pas de db.run asynchrone ici)
                            continueJoinLogic(ws, requestedConversationId, currentAdmin, isAdminOfThisConv);
                       }

                   }); // Fin du callback db.get pour l'admin
               }); // Fin du callback db.get pour l'autorisation (imbriqué)
           }); // Fin du callback db.get pour la conversation existante (imbriqué)


           break; // <-- Fin du case 'joinConversation'


       // *** NOUVELLE FONCTION pour encapsuler la logique de jonction commune ***
       // (Appelée depuis les callbacks asynchrones d'attribution/vérification admin)
       function continueJoinLogic(ws, conversationId, currentAdmin, isAdminStatus) {

           // 1. Retirer le client de sa conversation précédente (s'il y en avait une)
           if (ws.activeConversationId && clientsByConversation.has(ws.activeConversationId)) {
               const oldConvClients = clientsByConversation.get(ws.activeConversationId);
               oldConvClients.delete(ws);
               console.log(`${ws.userName} a quitté la conversation "${ws.activeConversationId}".`);
               // Retirer l'utilisateur de la liste de frappe de l'ancienne conversation
               if (typingUsersByConversation.has(ws.activeConversationId)) {
                   typingUsersByConversation.get(ws.activeConversationId).delete(ws.userName);
               }
               // Diffuser les listes mises à jour pour l'ancienne conversation
               broadcastUserList(ws.activeConversationId);
               broadcastTypingStatus(ws.activeConversationId);
               // Nettoyer les maps si l'ancienne conversation devient vide
               if (oldConvClients.size === 0) {
                   clientsByConversation.delete(ws.activeConversationId);
                   typingUsersByConversation.delete(ws.activeConversationId);
                   console.log(`Conversation vide "${ws.activeConversationId}" retirée des listes.`);
               }
           }

           // 2. Ajouter le client à la nouvelle conversation
           if (!clientsByConversation.has(conversationId)) {
               clientsByConversation.set(conversationId, new Set());
           }
           clientsByConversation.get(conversationId).add(ws);
           ws.activeConversationId = conversationId; // Mettre à jour la conversation active du client
           ws.isAdminOfActiveConversation = isAdminStatus; // Stocker son statut d'admin localement

           console.log(`${ws.userName} a rejoint la conversation "${ws.activeConversationId}" (autorisé). Admin: ${currentAdmin || 'aucun'}. Client est admin: ${isAdminStatus}`);
           ws.send(JSON.stringify({ type: 'system', text: `Vous avez rejoint la conversation "${ws.activeConversationId}".` }));

           // *** Envoyer l'information sur l'administrateur de cette conversation au client ***
           ws.send(JSON.stringify({
               type: 'conversationInfo',
               conversationId: conversationId,
               adminUser: currentAdmin, // Envoyer le nom de l'admin (peut être null)
               isAdmin: isAdminStatus // Envoyer si le client actuel est l'admin
           }));

           // 3. Envoyer l'historique de la nouvelle conversation au client
           sendHistoricalMessages(ws, ws.activeConversationId);

           // 4. Diffuser la liste des utilisateurs connectés et le statut de frappe pour la nouvelle conversation
           broadcastUserList(ws.activeConversationId);
           broadcastTypingStatus(ws.activeConversationId); // Envoyer aussi le statut de frappe au nouvel arrivant

           // 5. Informer les autres dans la nouvelle conversation (si nommé et autorisé)
           if (ws.userName) {
                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN && ws.activeConversationId === conversationId) { // Use conversationId
                         broadcastMessageToConversation(conversationId, { // Use conversationId
                            type: 'system',
                            text: `${ws.userName} a rejoint la conversation.`
                        });
                    }
                }, 100);
           }
       }


      case 'message':
        // ... (logic for message - no change in this part) ...
        if (ws.userName && ws.activeConversationId && parsedMessage.text && typeof parsedMessage.text === 'string' && parsedMessage.text.trim().length > 0) {

          const messageText = parsedMessage.text.trim().substring(0, 500);
          const conversationId = ws.activeConversationId;
          const senderName = ws.userName;


          db.run(`INSERT INTO messages (conversation_id, user, text) VALUES (?, ?, ?)`, [conversationId, senderName, messageText], function(insertErr) { // Utiliser senderName
            if (insertErr) {
              console.error('Erreur lors de l\'insertion du message en base', insertErr.message);
              ws.send(JSON.stringify({ type: 'error', text: 'Erreur lors de la sauvegarde du message.' }));
            } else {
              console.log(`Message #${this.lastID} inséré dans conv "${conversationId}" : ${senderName}: ${messageText}`); // Utiliser senderName

              const chatMessage = {
                type: 'message',
                conversationId: conversationId,
                user: senderName, // Utiliser senderName
                text: messageText,
                timestamp: new Date().toISOString()
              };

              // Diffuser le message formaté UNIQUEMENT aux clients DANS cette conversation
              broadcastMessageToConversation(conversationId, chatMessage);

              // *** NOUVEAU : Envoyer des notifications Push aux utilisateurs qui ne sont PAS CONNECTÉS à cette conversation ***
              // (Ou à ceux qui sont connectés mais pas sur cet onglet/appareil - c'est une simplification pour la démo)
              // Pour simplifier, on va envoyer la notification à TOUS les utilisateurs *autorisés* par cette conversation
              // qui ne sont PAS le sender et qui ont un abonnement.

              // 1. Récupérer les utilisateurs autorisés pour cette conversation
              db.all(`SELECT user_name FROM AllowedUsers WHERE conversation_id = ?`, [conversationId], (allowedErr, allowedRows) => {
                  if (allowedErr) {
                      console.error(`Erreur DB lors de la récupération des utilisateurs autorisés pour notifications ${conversationId}`, allowedErr.message);
                      return; // Ne pas bloquer l'envoi de message si cette partie échoue
                  }

                  const authorizedUserNames = allowedRows.map(row => row.user_name);

                  // 2. Identifier les destinataires potentiels de la notification (tous les autorisés SAUF l'expéditeur)
                  const potentialRecipients = authorizedUserNames.filter(name => name !== senderName);

                   console.log(`Potentiels destinataires de notification pour conv "${conversationId}" :`, potentialRecipients);


                  // 3. Pour chaque destinataire potentiel, vérifier s'il a un abonnement et l'envoyer
                  potentialRecipients.forEach(recipientName => {
                      // Dans une vraie application, il faudrait aussi vérifier si le destinataire est *actuellement actif*
                      // dans cette conversation pour ne pas envoyer une notification s'il est déjà en train de la regarder.
                      // Cela nécessiterait de parcourir wss.clients et vérifier activeConversationId et userName.
                      // Pour cette démo, on envoie si l'utilisateur n'est pas l'expéditeur et a un abonnement.

                       // Récupérer l'abonnement de l'utilisateur (si il existe)
                       db.get(`SELECT subscription FROM Subscriptions WHERE user_name = ?`, [recipientName], (subErr, subRow) => {
                            if (subErr) {
                                console.error(`Erreur DB lors de la récupération abonnement pour ${recipientName}`, subErr.message);
                                return;
                            }

                            if (subRow) {
                                // Abonnement trouvé, tenter d'envoyer la notification Push
                                try {
                                    const recipientSubscription = JSON.parse(subRow.subscription);

                                     // Payload simple pour la notification (le contenu affiché)
                                    const notificationPayload = JSON.stringify({
                                        title: `Nouveau message dans ${conversationId} de ${senderName}`, // Titre de la notification
                                        body: messageText, // Corps de la notification
                                        icon: '/chemin/vers/une/icone.png' // Optionnel: icône (le chemin doit être accessible publiquement)
                                        // data: { conversationId: conversationId } // Optionnel: données à passer au Service Worker
                                    });

                                    console.log(`Envoi notification Push à ${recipientName} pour message #${this.lastID}.`);

                                    webpush.sendNotification(recipientSubscription, notificationPayload)
                                        .then(() => {
                                            console.log(`Notification Push envoyée à ${recipientName}.`);
                                        })
                                        .catch(error => {
                                            console.error(`Échec envoi notification Push à ${recipientName}:`, error);
                                            // Si l'erreur est 410 GONE ou 404 NOT_FOUND, l'abonnement n'est plus valide, il faut le supprimer de la DB.
                                            if (error.statusCode === 410 || error.statusCode === 404) {
                                                console.warn(`Abonnement Push pour ${recipientName} invalide ou expiré. Suppression de la base...`);
                                                 db.run(`DELETE FROM Subscriptions WHERE user_name = ?`, [recipientName], deleteErr => {
                                                     if(deleteErr) console.error(`Erreur DB lors suppression abonnement invalide ${recipientName}`, deleteErr.message);
                                                     else console.log(`Abonnement invalide pour ${recipientName} supprimé.`);
                                                 });
                                            }
                                        });

                                } catch (parseError) {
                                    console.error(`Erreur lors du parsing de l'abonnement DB pour ${recipientName}`, parseError);
                                }
                            } else {
                                // Aucun abonnement trouvé pour cet utilisateur
                                console.log(`Aucun abonnement Push trouvé pour ${recipientName}.`);
                            }
                       }); // Fin du callback db.get pour l'abonnement
                  }); // Fin du forEach sur les destinataires potentiels

              }); // Fin du callback db.all pour les allowedUsers


              // L'utilisateur a envoyé un message, il n'est plus en train de taper... (logique existante)
              if (typingUsersByConversation.has(conversationId)) {
                  const typingSet = typingUsersByConversation.get(conversationId);
                   if (typingSet.delete(senderName)) { // Utiliser senderName
                        console.log(`${senderName} a arrêté de taper en envoyant un message.`); // Utiliser senderName
                       broadcastTypingStatus(conversationId);
                        if (typingSet.size === 0) {
                            typingUsersByConversation.delete(conversationId);
                            console.log(`Liste de frappe vide pour "${conversationId}" retirée.`);
                        }
                   }
              }

            } // Fin du else (insertion DB réussie)
          }); // Fin du db.run pour l'insertion du message

        } // Fin du if (validation message)
        else if (!ws.userName) {
             ws.send(JSON.stringify({ type: 'system', text: 'Veuillez définir votre nom d\'utilisateur avant d\'envoyer un message.' }));
        } else if (!ws.activeConversationId) {
             ws.send(JSON.stringify({ type: 'system', text: 'Veuillez rejoindre une conversation avant d\'envoyer un message.' }));
        }
         else {
            ws.send(JSON.stringify({ type: 'error', text: 'Contenu du message non valide.' }));
        }
        break; // Fin du case 'message'

      // Gérer la réception et la sauvegarde de l'abonnement Push
      case 'saveSubscription':
           // S'assurer que le client est identifié et que l'abonnement est valide
          if (!ws.userName || !parsedMessage.subscription || typeof parsedMessage.subscription !== 'object') {
              console.warn('Tentative de sauvegarder un abonnement invalide ou sans nom.');
              return;
          }

          const subscription = parsedMessage.subscription;
          if (!subscription.endpoint) {
               console.warn('Abonnement invalide reçu : missing endpoint.');
               return;
          }

          console.log(`Réception abonnement Push pour utilisateur ${ws.userName}.`);

           // Sauvegarder l'abonnement en base de données
           // Utiliser INSERT OR REPLACE pour remplacer l'ancien abonnement si l'utilisateur s'abonne à nouveau
          db.run(`INSERT OR REPLACE INTO Subscriptions (user_name, subscription) VALUES (?, ?)`, [ws.userName, JSON.stringify(subscription)], function(insertErr) {
               if (insertErr) {
                   console.error(`Erreur DB lors de la sauvegarde de l'abonnement pour ${ws.userName}`, insertErr.message);
               } else {
                   console.log(`Abonnement Push sauvegardé pour ${ws.userName}.`);
               }
          });

          break; // Fin du case 'saveSubscription'


      case 'typing':
          // ... (logic for typing - no change in this part) ...
           if (ws.userName && ws.activeConversationId && typeof parsedMessage.isTyping === 'boolean') {
              const conversationId = ws.activeConversationId;

              if (!typingUsersByConversation.has(conversationId)) {
                  typingUsersByConversation.set(conversationId, new Set());
              }
              const typingSet = typingUsersByConversation.get(conversationId);

              const wasTyping = typingSet.has(ws.userName);
              const isTypingNow = parsedMessage.isTyping;

              if (isTypingNow && !wasTyping) {
                  typingSet.add(ws.userName);
                  console.log(`${ws.userName} est en train d'écrire dans "${conversationId}".`);
                  broadcastTypingStatus(conversationId);
              } else if (!isTypingNow && wasTyping) {
                  typingSet.delete(ws.userName);
                  console.log(`${ws.userName} a arrêté d'écrire dans "${conversationId}".`);
                  broadcastTypingStatus(conversationId);
                   if (typingSet.size === 0) {
                       typingUsersByConversation.delete(conversationId);
                       console.log(`Liste de frappe vide pour "${conversationId}" retirée.`);
                   }
              }
          } else {
              console.warn(`Message 'typing' invalide ou incomplet de ${ws.userName || 'anonyme'} dans conv ${ws.activeConversationId || 'aucune'}`);
          }
          break;


      // Gérer la demande de la liste des utilisateurs autorisés par l'admin
      case 'requestAllowedUsers':
          // Vérifier que l'utilisateur est bien l'admin de la conversation spécifiée dans la requête
          // ET qu'il est bien dans cette conversation activement.
          // On peut simplifier la vérification si on fait confiance au client (moins sécurisé) ou la refaire en DB.
          // Refaisons la vérification admin en DB pour plus de sécurité ici.
          if (!ws.userName || !parsedMessage.conversationId) {
              ws.send(JSON.stringify({ type: 'system', text: 'Action non autorisée.' }));
               console.warn(`Demande requestAllowedUsers sans nom ou conversationId.`);
              return;
          }

          const convIdForList = parsedMessage.conversationId;

          // Vérifier en DB si cet utilisateur est l'admin de cette conversation
           db.get(`SELECT admin_user FROM Conversations WHERE id = ?`, [convIdForList], (err, row) => {
               if(err || !row || row.admin_user !== ws.userName) {
                   // Si erreur, conv n'existe pas ou n'est pas admin
                   ws.send(JSON.stringify({ type: 'system', text: 'Action non autorisée.' }));
                   console.warn(`${ws.userName} (non admin de "${convIdForList}") a tenté de demander la liste des autorisés.`);
               } else {
                    // L'utilisateur est bien l'admin, envoyer la liste
                   console.log(`${ws.userName} (admin de "${convIdForList}") demande la liste des utilisateurs autorisés.`);
                   sendAllowedUsersList(ws, convIdForList); // Appelle la fonction qui fait la DB query et envoie
               }
           });
          break;


      // *** Gérer l'ajout/suppression d'utilisateurs par l'admin ***
      case 'manageMembership':
          // Vérification d'autorisation (existante et correcte)
          // Refaire la vérification admin en DB pour plus de sécurité ici.
          if (!ws.userName || !ws.activeConversationId || ws.activeConversationId !== parsedMessage.conversationId) {
              ws.send(JSON.stringify({ type: 'system', text: 'Action non autorisée.' }));
              console.warn(`${ws.userName || 'Anonyme'} (pas dans conv active ou conv mismatch) a tenté de gérer les membres dans "${ws.activeConversationId || 'aucune'}".`);
              return;
          }
           const convIdToManage = ws.activeConversationId; // L'admin gère la conversation dans laquelle il se trouve

           // Vérifier en DB si cet utilisateur est l'admin de la conversation active
           db.get(`SELECT admin_user FROM Conversations WHERE id = ?`, [convIdToManage], (err, row) => {
               if(err || !row || row.admin_user !== ws.userName) {
                   // Si erreur, conv n'existe pas ou n'est pas admin
                   ws.send(JSON.stringify({ type: 'system', text: 'Action non autorisée.' }));
                   console.warn(`${ws.userName} (non admin de "${convIdToManage}") a tenté de gérer les membres.`);
               } else {
                    // L'utilisateur est bien l'admin, procéder à l'action d'ajout/suppression
                   const action = parsedMessage.action; // 'add' ou 'remove'
                   const targetUserName = parsedMessage.userName; // Le nom de l'utilisateur à ajouter/supprimer
                   const trimmedTargetUserName = targetUserName.trim().substring(0, 20); // Nettoyer et limiter le nom cible

                    if (!action || !trimmedTargetUserName || typeof trimmedTargetUserName !== 'string' || (action !== 'add' && action !== 'remove')) {
                         ws.send(JSON.stringify({ type: 'error', text: 'Commande de gestion des membres invalide.' }));
                         console.warn(`Commande manageMembership invalide de ${ws.userName} :`, parsedMessage);
                         return;
                    }

                    // Ne pas permettre à l'admin de se retirer lui-même de la liste des autorisés (pour éviter de bloquer la conversation)
                     if (action === 'remove' && trimmedTargetUserName === ws.userName) {
                          ws.send(JSON.stringify({ type: 'system', text: 'Vous ne pouvez pas vous retirer vous-même de la liste des utilisateurs autorisés.' }));
                         console.warn(`${ws.userName} a tenté de se retirer de la liste des autorisés pour "${convIdToManage}".`);
                         return;
                     }
                     // Ne pas permettre à l'admin de se retirer lui-même de son statut d'admin
                     // Note: La gestion du statut admin est séparée de la liste des autorisés, mais c'est un point à considérer.
                     // Pour l'instant, le premier admin reste admin.


                    if (action === 'add') {
                        // Ajouter l'utilisateur à la table AllowedUsers pour cette conversation
                        db.run(`INSERT OR IGNORE INTO AllowedUsers (conversation_id, user_name) VALUES (?, ?)`, [convIdToManage, trimmedTargetUserName], function(insertErr) {
                            if (insertErr) {
                                console.error(`Erreur DB lors de l'ajout de ${trimmedTargetUserName} à ${convIdToManage}`, insertErr.message);
                                ws.send(JSON.stringify({ type: 'error', text: `Erreur lors de l'ajout de ${trimmedTargetUserName}.` }));
                            } else if (this.changes > 0) { // Si une ligne a été ajoutée
                                console.log(`${ws.userName} (admin de "${convIdToManage}") a ajouté "${trimmedTargetUserName}".`);
                                ws.send(JSON.stringify({ type: 'system', text: `"${trimmedTargetUserName}" a été ajouté à la liste des utilisateurs autorisés pour "${convIdToManage}".` }));
                                // *** Renvoyer la liste mise à jour à l'admin après l'ajout ***
                                sendAllowedUsersList(ws, convIdToManage); // Renvoyer la liste mise à jour à l'admin
                                 // Optionnel : Notifier le user ciblé s'il est connecté globalement ?
                            } else { // Si this.changes === 0, l'utilisateur était déjà autorisé
                                console.log(`${trimmedTargetUserName} était déjà autorisé dans "${convIdToManage}".`);
                                ws.send(JSON.stringify({ type: 'system', text: `"${trimmedTargetUserName}" était déjà dans la liste des utilisateurs autorisés.` }));
                                // Optionnel : Renvoyer la liste mise à jour même si pas de changement ?
                                // sendAllowedUsersList(ws, convIdToManage);
                            }
                        });

                    } else if (action === 'remove') {
                        // Supprimer l'utilisateur de la table AllowedUsers pour cette conversation
                        db.run(`DELETE FROM AllowedUsers WHERE conversation_id = ? AND user_name = ?`, [convIdToManage, trimmedTargetUserName], function(deleteErr) {
                            if (deleteErr) {
                                console.error(`Erreur DB lors de la suppression de ${trimmedTargetUserName} de ${convIdToManage}`, deleteErr.message);
                                ws.send(JSON.stringify({ type: 'error', text: `Erreur lors de la suppression de ${trimmedTargetUserName}.` }));
                            } else if (this.changes > 0) { // Si une ligne a été supprimée
                                console.log(`${ws.userName} (admin de "${convIdToManage}") a supprimé "${trimmedTargetUserName}".`);
                                ws.send(JSON.stringify({ type: 'system', text: `"${trimmedTargetUserName}" a été retiré de la liste des utilisateurs autorisés pour "${convIdToManage}".` }));
                                 // *** NOUVEAU : Renvoyer la liste mise à jour à l'admin après la suppression ***
                                 sendAllowedUsersList(ws, convIdToManage); // Renvoyer la liste mise à jour à l'admin

                                // Si l'utilisateur supprimé est actuellement connecté à cette conversation, on devrait l'en retirer !
                                 wss.clients.forEach(client => {
                                     if (client.userName === trimmedTargetUserName && client.activeConversationId === convIdToManage && client.readyState === WebSocket.OPEN) {
                                          console.log(`Déconnecté ${trimmedTargetUserName} de la conversation "${convIdToManage}" car retiré des autorisés.`);
                                        // Déclencher la logique de 'close' pour ce client avec un code spécifique pour la déconnexion administrative.
                                          client.close(4000, 'Retiré de la conversation par l\'administrateur.'); // Code 4000-4999 réservé aux applications
                                          // La logique de 'close' handler gérera le reste (nettoyage des maps, diffusion)
                                     }
                                 });

                            } else { // Si this.changes === 0, l'utilisateur n'était pas dans la liste des autorisés
                                console.log(`${trimmedTargetUserName} n'était pas autorisé dans "${convIdToManage}".`);
                                ws.send(JSON.stringify({ type: 'system', text: `"${trimmedTargetUserName}" n'était pas dans la liste des utilisateurs autorisés.` }));
                                 // Optionnel : Renvoyer la liste mise à jour même si pas de changement ?
                                 // sendAllowedUsersList(ws, convIdToManage);
                            }
                        });
                    }
               }
           });
          break;

        // Gérer la demande de création de conversation
        case 'createConversation':
            // S'assurer que le client est connecté et identifié
            if (!ws.userName) {
                ws.send(JSON.stringify({ type: 'system', text: 'Veuillez vous identifier avant de créer une conversation.' }));
                return;
            }

            const newConversationName = parsedMessage.name;
            if (!newConversationName || typeof newConversationName !== 'string' || newConversationName.trim() === '') {
                ws.send(JSON.stringify({ type: 'error', text: 'Nom de conversation invalide.' }));
                return;
            }

            const trimmedConvName = newConversationName.trim().substring(0, 20); // Nettoyer et limiter la longueur

            // Ajouter validation côté serveur (basique)
             if (!/^[a-zA-Z0-9_-]+$/.test(trimmedConvName)) {
                 ws.send(JSON.stringify({ type: 'error', text: 'Le nom de la conversation ne peut contenir que des lettres, chiffres, tirets (-) et underscores (_).' }));
                 return;
             }
              // Vérifier si le nom n'est pas un ID prédéfini (pour éviter les conflits initiaux)
             if (predefinedConversations.includes(trimmedConvName)) {
                 ws.send(JSON.stringify({ type: 'error', text: `Le nom "${trimmedConvName}" est réservé.` }));
                 return;
             }


            console.log(`Tentative de création de conversation "${trimmedConvName}" par ${ws.userName}.`);

            // *** Logique d'ajout de la nouvelle conversation en base ***

            // 1. Insérer la nouvelle conversation dans la table Conversations (avec le créateur comme admin)
            // On utilise INSERT OR IGNORE au cas où un autre client créerait le même nom en même temps.
            db.run(`INSERT OR IGNORE INTO Conversations (id, admin_user) VALUES (?, ?)`, [trimmedConvName, ws.userName], function(insertConvErr) {
                if (insertConvErr) {
                    console.error(`Erreur DB lors de la création conversation ${trimmedConvName}`, insertConvErr.message);
                    ws.send(JSON.stringify({ type: 'error', text: `Erreur lors de la création de la conversation "${trimmedConvName}".` }));
                    return; // Sortir si erreur DB
                }

                if (this.changes === 0) { // Si 0 ligne ajoutée, cela signifie que la conversation existait déjà avec cet ID
                    console.warn(`Conversation "${trimmedConvName}" existait déjà. ${ws.userName} ne devient pas admin auto.`);
                     // Optionnel : vérifier si l'utilisateur est autorisé/admin pour la rejoindre au lieu de créer
                     ws.send(JSON.stringify({ type: 'system', text: `La conversation "${trimmedConvName}" existe déjà.` }));

                      // On renvoie quand même la liste des conversations au créateur, il pourrait être autorisé.
                       db.all(`SELECT conversation_id FROM AllowedUsers WHERE user_name = ?`, [ws.userName], (err, rows) => {
                          if (err) { console.error(`Erreur DB lors de la récupération convs autorisées (après création) pour ${ws.userName}`, err.message); }
                          else {
                              const authorizedConversations = rows.map(row => row.conversation_id); // Juste celles autorisées
                              console.log(`Envoi liste autorisée mise à jour (après création) à ${ws.userName}.`);
                              ws.send(JSON.stringify({ type: 'availableConversations', conversations: authorizedConversations }));
                          }
                      });

                     return; // Sortir si la conversation existait déjà
                }

                // Si la conversation a bien été créée (this.changes > 0)
                console.log(`Conversation "${trimmedConvName}" créée par ${ws.userName} (admin).`);
                 ws.send(JSON.stringify({ type: 'system', text: `Conversation "${trimmedConvName}" créée avec succès ! Vous êtes l'administrateur.` }));


                // 2. Ajouter l'utilisateur créateur à la table AllowedUsers pour ce nouveau groupe
                db.run(`INSERT OR IGNORE INTO AllowedUsers (conversation_id, user_name) VALUES (?, ?)`, [trimmedConvName, ws.userName], function(insertAllowedErr) {
                     if(insertAllowedErr) {
                         console.error(`Erreur DB lors de l'ajout de ${ws.userName} à AllowedUsers pour ${trimmedConvName}`, insertAllowedErr.message);
                          ws.send(JSON.stringify({ type: 'error', text: `Erreur lors de l'ajout de vous-même à la liste des autorisés.` }));
                         // La conversation est créée, mais l'admin ne peut pas la rejoindre s'il n'est pas dans AllowedUsers. C'est problématique.
                         // Il faudrait gérer cette erreur plus robustement. Pour la démo, on continue.
                     } else {
                         console.log(`${ws.userName} ajouté à AllowedUsers pour "${trimmedConvName}".`);
                     }

                     // *** Renvoie la liste mise à jour des conversations au créateur ***
                      // (Maintenant qu'il est ajouté à AllowedUsers pour ce nouveau groupe)
                       db.all(`SELECT conversation_id FROM AllowedUsers WHERE user_name = ?`, [ws.userName], (err, rows) => {
                          if (err) {
                              console.error(`Erreur DB lors de la récupération convs autorisées (après création) pour ${ws.userName}`, err.message);
                              ws.send(JSON.stringify({ type: 'error', text: 'Erreur lors de la mise à jour de vos conversations.' }));
                          } else {
                              const authorizedConversations = rows.map(row => row.conversation_id); // Juste celles autorisées
                              console.log(`Envoi liste autorisée mise à jour (après création) à ${ws.userName}.`);
                              ws.send(JSON.stringify({ type: 'availableConversations', conversations: authorizedConversations }));
                          }
                      });

                }); // Fin du callback db.run pour l'insertion dans AllowedUsers

            }); // Fin du callback db.run pour l'insertion dans Conversations


            break; // <-- Fin du case 'createConversation'


        default:
          // Type de message inconnu
          console.warn(`Message de type inconnu reçu de ${ws.userName || 'anonyme'} dans conv ${ws.activeConversationId || 'aucune'}: ${messageString}`);
          ws.send(JSON.stringify({ type: 'error', text: `Type de message inconnu: ${parsedMessage.type}` }));
          break;
      }
    });

    // 8. Gérer la fermeture d'une connexion WebSocket
    ws.on('close', (event) => { // Accéder à l'objet event pour le code et la raison
      const userName = ws.userName;
      const activeConversationId = ws.activeConversationId;

      // Log la raison de la fermeture si ce n'est pas une fermeture normale (1000)
      if (event.code !== 1000) {
          console.log(`Client ${userName || 'Anonyme'} déconnecté de ${activeConversationId || 'aucune conv'} avec code ${event.code} et raison : ${event.reason}`);
      } else {
           console.log(`Client ${userName || 'Anonyme'} déconnecté normalement de ${activeConversationId || 'aucune conv'}.`);
      }


      if (activeConversationId && clientsByConversation.has(activeConversationId)) {
          const clientsInConversation = clientsByConversation.get(activeConversationId);
          // Retirer le client de la conversation active
          clientsInConversation.delete(ws);
          console.log(`${userName || 'Client anonyme'} retiré de la liste connectés pour "${activeConversationId}".`);


          // Diffuser la liste mise à jour des utilisateurs connectés pour cette conversation
          broadcastUserList(activeConversationId);

          // Informer les autres (dans cette conversation) que l'utilisateur est parti (si nommé)
          if (userName) {
              // Vérifier si le client n'a pas été retiré administrativement (code 4000) pour un message de sortie personnalisé.
              if (event.code === 4000) {
                   broadcastMessageToConversation(activeConversationId, {
                      type: 'system',
                      text: `${userName} a été retiré de la conversation par l\'administrateur.` // Message spécifique pour retrait admin
                   });
              } else {
                   broadcastMessageToConversation(activeConversationId, {
                      type: 'system',
                      text: `${userName} a quitté le chat.` // Message par défaut
                   });
              }


              // Retirer l'utilisateur de la liste de frappe s'il tapait
              if (typingUsersByConversation.has(activeConversationId)) {
                  const typingSet = typingUsersByConversation.get(activeConversationId);
                  if (typingSet.delete(userName)) { // S'il était bien dans la liste de frappe
                       console.log(`Retiré ${userName} de la liste de frappe pour "${activeConversationId}".`);
                      broadcastTypingStatus(activeConversationId); // Diffuser le changement
                  }
                   // Nettoyer la map typingUsersByConversation si le Set devient vide
                   if (typingSet.size === 0) {
                       typingUsersByConversation.delete(activeConversationId);
                       console.log(`Liste de frappe vide pour "${activeConversationId}" retirée.`);
                   }
              }
          }

           // Nettoyer la map clientsByConversation si la conversation devient vide
           if (clientsInConversation.size === 0) {
               clientsByConversation.delete(activeConversationId);
               console.log(`Conversation vide "${activeConversationId}" retirée.`);
               // Note: typingUsersByConversation est aussi nettoyé si le Set était vide, mais pas si l'admin reste seul.
           }

      } else {
          console.log(`${userName || 'Client anonyme'} déconnecté (sans conversation active).`);
      }
    });

     // 9. Gérer les erreurs WebSocket (pas de changement majeur)
     ws.on('error', (error) => {
         console.error(`Erreur WebSocket pour ${ws.userName || 'un client anonyme'} dans conv ${ws.activeConversationId || 'aucune'}:`, error);
         // L'événement 'close' sera déclenché automatiquement après une erreur.
     });

});


// Fonction pour récupérer et envoyer l'historique des messages (pas de changement)
function sendHistoricalMessages(ws, conversationId, limit = 50) {
    if (!conversationId) {
        console.warn('sendHistoricalMessages appelé sans conversationId');
        return;
    }
    db.all(`SELECT user, text, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT ?`, [conversationId, limit], (err, rows) => {
        if (err) {
            console.error(`Erreur lors de la lecture de l\'historique pour ${conversationId}`, err.message);
            ws.send(JSON.stringify({ type: 'error', text: 'Erreur lors du chargement de l\'historique des messages.' }));
        } else {
            console.log(`Envoi de ${rows.length} messages historiques pour conv "${conversationId}" au client ${ws.userName}.`);
            rows.forEach((row) => {
                ws.send(JSON.stringify({
                    type: 'message',
                    conversationId: conversationId,
                    user: row.user,
                    text: row.text,
                    timestamp: row.timestamp
                }));
            });
        }
    });
}


// 10. Faire écouter le serveur (pas de changement)
server.listen(port, () => {
  console.log(`Serveur HTTP et WebSocket écoutant sur le port ${port}`);
  console.log(`Pour accéder au serveur HTTP : http://localhost:${port}`);
});

// Gérer la fermeture de la base de données quand le serveur s'arrête (Ctrl+C) (pas de changement majeur)
process.on('SIGINT', () => {
    console.log('Signal SIGINT reçu, fermeture de la base de données...');
    wss.clients.forEach(client => {
         if (client.readyState === WebSocket.OPEN) {
              client.close(1000, 'Serveur arrêté');
         }
    });

    setTimeout(() => {
        db.close((err) => {
            if (err) {
                console.error('Erreur lors de la fermeture de la base de données', err.message);
            } else {
                 console.log('Base de données fermée.');
            }
            process.exit(0);
        });
    }, 500);
});