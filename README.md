# Blanchisserie Cézanne — backend

API + base de données SQLite pour l'application Blanchisserie Cézanne.
Remplace le stockage temporaire de la version précédente (dans l'artefact
Claude) par un vrai serveur Node.js/Express et une base de données SQLite
persistante sur disque.

## Ce qui change par rapport à la version précédente

| | Version artefact (précédente) | Cette version (backend réel) |
|---|---|---|
| Stockage | `window.storage` du navigateur, lié à la conversation Claude | Fichier SQLite sur disque (`data/database.sqlite`) |
| Mots de passe / codes | Hachés en SHA-256 côté navigateur | Hachés en bcrypt côté serveur |
| Session client / admin | Perdue au rechargement de la page | Persiste via cookie de session (30 jours) |
| Bon de livraison | Ouvre votre messagerie (mailto) | Peut être envoyé réellement par email via SMTP (avec repli sur mailto si non configuré) |
| Accès aux données | Uniquement depuis le navigateur ayant créé la commande | Accessible depuis n'importe quel navigateur pointant vers le serveur |

## Prérequis

- Node.js 18 ou supérieur
- npm

## Installation

```bash
cd blanchisserie-backend
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez au minimum `SESSION_SECRET` (n'importe quelle
chaîne longue et aléatoire). La partie SMTP est optionnelle — voir plus bas.

```bash
npm start
```

Le serveur démarre sur `http://localhost:3000` (ou le port défini dans
`.env`). Ouvrez cette adresse dans votre navigateur : c'est l'application
complète (accueil, commande, suivi, espace personnel, administration).

> **Note sur cet environnement (Claude) :** je n'ai pas pu exécuter
> `npm install` ni démarrer le serveur moi-même ici, car cet outil n'a pas
> d'accès réseau. Le code a été écrit et relu avec soin (syntaxe vérifiée
> fichier par fichier), mais testez-le chez vous avec `npm install && npm start`
> avant toute mise en production.

## Premier lancement

- **Espace client** : inscription libre depuis l'onglet « Mon espace ».
- **Administration** : la première visite de l'onglet « Administration »
  demande de définir un mot de passe (6 caractères minimum). Ce mot de passe
  est ensuite haché et stocké en base — il n'y a pas de mot de passe par défaut.

## Base de données

- Moteur : **SQLite**, via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).
- Fichier : `data/database.sqlite`, créé automatiquement au premier démarrage.
- Schéma : défini dans [`src/schema.sql`](src/schema.sql), appliqué
  automatiquement par `src/db.js` à chaque démarrage.

### Tables

- **clients** — comptes de l'espace personnel (email, coordonnées, code d'accès haché).
- **client_documents** — PDF du contrat et documents communs visibles de l'hôtel (contenu en base, donc sauvegardé).
- **orders** — une ligne par commande (ticket, client associé ou invité, statut, dates, notes).
- **order_items** — les articles d'une commande (catégorie de linge, quantité), liés à `orders` par `order_id`.
- **admin** — une seule ligne (mot de passe haché + email de réception des bons de livraison).
- **order_seq** — compteur utilisé pour générer les numéros de ticket (`CZ-AAMMJJ-XXXX`).
- **machines**, **employees**, **time_entries**, **badge_terminals** — la partie Équipe (voir « Équipe (RH) et badgeuse »).

### Consulter la base directement

Pour inspecter ou modifier les données à la main, utilisez par exemple
[DB Browser for SQLite](https://sqlitebrowser.org/) (interface graphique)
ou la ligne de commande `sqlite3 data/database.sqlite` si elle est installée
sur votre machine.

### Modifier le schéma

`src/schema.sql` utilise `CREATE TABLE IF NOT EXISTS` : si vous modifiez ce
fichier après une première exécution, les tables déjà créées **ne seront
pas modifiées automatiquement** (SQLite ne fait pas de migration implicite).
Deux options :

1. **En développement**, le plus simple est de supprimer `data/database.sqlite`
   (perte des données) et de relancer `npm start` pour repartir d'un schéma propre.
2. **En production**, écrivez une migration explicite (`ALTER TABLE ...`)
   dans un script à part et exécutez-la une fois avant de redémarrer le serveur.

## Aperçu de l'API

Toutes les routes sont préfixées par `/api`. Les sessions client et
administration sont gérées par cookie (`credentials: 'same-origin'` côté
frontend).

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/services` | Catalogue des catégories de linge |
| POST | `/api/clients/register` | Créer un compte client |
| POST | `/api/clients/login` | Connexion client |
| POST | `/api/clients/logout` | Déconnexion client |
| GET | `/api/clients/me` | Session client courante |
| GET | `/api/clients/orders` | Historique du client connecté |
| POST | `/api/orders` | Créer une commande (invité ou client connecté) |
| GET | `/api/orders/track/:ticket` | Suivi public par numéro de ticket |
| GET | `/api/admin/status` | Admin déjà configuré ? session déverrouillée ? |
| POST | `/api/admin/setup` | Définir le mot de passe (une seule fois) |
| POST | `/api/admin/login` / `/logout` | Connexion / déconnexion admin |
| GET | `/api/admin/orders` | Toutes les commandes |
| PATCH | `/api/admin/orders/:id/status` | Faire avancer le statut |
| PATCH | `/api/admin/orders/:id/items` | Modifier les quantités (commande en traitement) |
| GET/PUT | `/api/admin/settings` | Email de réception des bons de livraison |
| POST | `/api/admin/orders/:id/delivery-note` | Générer / envoyer le bon de livraison |

## Organisation de l'espace admin

L'administration est organisée en sous-onglets (les articles, tarifs et fiches hôtels sont dans **Plus → Facturation**, derrière son code ; 
« Plus → Chariots et camions » regroupe les équipements de logistique) :

- **Production** — kanban à 5 étapes (Tri → Lavage → Séchage → Repassage →
  Pliage/emballage) pour les commandes actuellement "en traitement".
  Glisser-déposer une étiquette d'une étape à l'autre.
- **Préparation de commande** — le kanban historique par statut (Reçue → En
  traitement → Prête → Livrée), inchangé.
- **Logistique livraison** — gérez vos chauffeurs (nom + véhicule optionnel),
  puis glissez les commandes "prêtes" vers le chauffeur qui les livrera.
  Une colonne "Non assigné" regroupe celles pas encore prises en charge.
- **Équipe** — collaborateurs rattachés à une BU ou à une machine, badgeuse de l'atelier, présence en direct et heures
  pointées par poste (voir « Équipe (RH) et badgeuse »).
- **Statistiques** — un seul filtre de dates en haut de page pilote tout :
  activité jour par jour, chiffres clés (commandes reçues et livrées, articles,
  hôtels actifs, poids, km), NPS, répartition par statut, top hôtels et
  articles les plus commandés.
- **Historique des livraisons** et **Commandes automatiques** — inchangés,
  voir plus bas.

Cliquer sur une étiquette (Production, Logistique, kanban principal) ouvre
toujours le même aperçu détaillé de la commande, avec édition des quantités
livrées si elle est "en traitement".

## Commandes automatiques (planning hôtel)

Dans Administration → « Commandes automatiques », commencez par **choisir un
hôtel** dans la liste déroulante (chaque hôtel correspond à un compte client
enregistré dans « Mon espace » — un établissement doit donc créer son compte
avant d'apparaître ici). Les types de chambre, le simulateur et les
commandes générées sont **entièrement propres à l'hôtel sélectionné** : deux
établissements peuvent avoir une chambre nommée « Double » avec des
quantités de linge complètement différentes, sans jamais se mélanger.

Une fois un hôtel choisi, vous définissez ses **types de chambre** avec deux règles :

- **Linge de départ** : ce qui part systématiquement quand une chambre fait
  son checkout (draps, housse de couette, taies...).
- **Linge de recouche** : ce qui est changé pendant le séjour (serviettes,
  drap de bain...), avec une fréquence en jours.

Chaque type de chambre peut avoir des **exceptions par mois** (ex. recouche
tous les 2 jours en juillet-août au lieu de 3) — un mois non renseigné suit
la règle par défaut.

En dessous, un simulateur calcule le linge nécessaire pour un ensemble de
séjours de cet hôtel (type de chambre + date d'arrivée + date de départ), et
peut créer la commande correspondante en un clic — les coordonnées
(société, contact, adresse) sont reprises automatiquement depuis le compte
de l'hôtel, pas besoin de les ressaisir à chaque commande.

**Amenitiz (PMS hôtelier)** : le connecteur qui alimenterait automatiquement
la liste des séjours depuis le planning Amenitiz n'est pas encore branché —
il nécessite un accès API côté Amenitiz (à demander à leur support), et
devra probablement gérer un identifiant de propriété Amenitiz par hôtel
(champ à ajouter sur la fiche client). Le moteur de calcul
(`src/utils/autoOrderRules.js`) est déjà prêt à recevoir ces données ; il
suffira d'ajouter une route qui interroge l'API Amenitiz
et transforme ses réservations en `stays` au même format que le simulateur.

## Envoi réel des bons de livraison par email

Sans configuration SMTP dans `.env`, le bouton « Générer le bon de livraison »
renvoie le texte du bon avec un lien de repli qui ouvre votre messagerie
(comme dans la version précédente).

Pour un envoi automatique réel, renseignez dans `.env` :

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=vous@gmail.com
SMTP_PASS=un-mot-de-passe-d-application
SMTP_FROM="Blanchisserie Cézanne <vous@gmail.com>"
```

Avec Gmail, utilisez un [mot de passe d'application](https://myaccount.google.com/apppasswords)
plutôt que votre mot de passe habituel. N'importe quel autre fournisseur
SMTP (OVH, Infomaniak, Resend, SendGrid en mode SMTP...) fonctionne de la
même façon.

## Déploiement (hébergement en continu)

Cette application (un processus Node.js + un fichier SQLite) convient bien à
un hébergeur avec **disque persistant**. **Render** est recommandé : simple,
documentation à jour, disque persistant géré, domaine personnalisé et HTTPS
gratuit inclus.

Coût indicatif chez Render (vérifié août 2026, sujet à changement — voir
[render.com/pricing](https://render.com/pricing)) : espace de travail Hobby
gratuit + service web « Starter » à 7 $/mois (toujours actif, sans mise en
veille) + disque persistant à 0,25 $/Go/mois → environ **7 à 8 $/mois** au
total pour ce projet. Le plan gratuit existe mais se met en veille après 15
minutes d'inactivité (mauvaise expérience pour un client qui commande), et
ne permet pas d'attacher de disque persistant — à éviter pour un usage réel.

### Étapes résumées

1. Poussez ce projet sur un dépôt GitHub.
2. Sur [render.com](https://render.com), créez un **Web Service** relié à ce dépôt.
   - Build command : `npm install`
   - Start command : `npm start`
3. Dans les réglages du service, ajoutez un **disque persistant** (Disks),
   par exemple monté sur `/var/data`.
4. Ajoutez les variables d'environnement du service (voir `.env.example`) :
   - `SESSION_SECRET` — une chaîne aléatoire longue
   - `DATA_DIR` — le chemin du disque monté, ex. `/var/data`
   - les variables `SMTP_*` si vous voulez l'envoi réel des bons de livraison
5. Une fois le service en ligne, allez dans **Settings → Custom Domains**,
   ajoutez votre (sous-)domaine, puis créez l'enregistrement DNS demandé
   (CNAME pour un sous-domaine type `commande.votredomaine.fr` — c'est
   l'option la plus simple ; A/ALIAS pour un domaine racine) chez votre
   registrar. Render délivre automatiquement le certificat HTTPS une fois
   la vérification DNS passée.

En VPS classique (Hetzner, OVH, DigitalOcean...), le disque est persistant
par défaut : `DATA_DIR` peut rester vide, mais il faut alors gérer soi-même
Node, un gestionnaire de process (pm2 ou systemd), et un reverse proxy
(nginx/Caddy) pour le HTTPS — plus de travail, mais aucun abonnement mensuel
de plateforme.

En production, quel que soit l'hébergeur, pensez à :
- définir un `SESSION_SECRET` long et aléatoire, différent de celui utilisé en local ;
- derrière un reverse proxy : c'est déjà géré dans `src/server.js` (`trust proxy` à 2 sur Render — Cloudflare puis Render, mesuré —
  et à 1 ailleurs ; cookie « Secure » automatique dès que la connexion est en HTTPS). Si l'hébergeur place un autre nombre de relais
  devant l'application, régler `TRUST_PROXY` (nombre de relais) ; `TRUST_PROXY=0` pour un lancement sans relais.

## Espace client

Ce que voit un hôtel quand il se connecte (page d'accueil du site). Le bouton « Nouvelle commande » reste en tête ; dessous, cinq onglets
(`public/espace.js`, balisage dans `public/index.html`, styles `esp-*` dans `public/styles.css`) :

- **Accueil** : le « Reste à payer » (dont le retard) avec un lien vers les factures, les commandes en cours avec leur avancement (reçue →
  en traitement → prête → livrée) et la date de livraison prévue, les trois dernières livraisons, les documents utiles (dernière facture,
  dernier bon de livraison, contrat signé), les coordonnées de la blanchisserie et le questionnaire de satisfaction.
- **Factures** : voir ci-dessous. Le nombre de factures à régler s'affiche en pastille sur l'onglet (rouge s'il y a du retard).
- **Contrat** : ce qui lie l'hôtel à la blanchisserie, en lecture seule — conditions de règlement (délai de paiement, mode de règlement :
  virement ou prélèvement SEPA avec la référence de son mandat, escompte s'il lui est proposé, détail des lignes de facture, pénalités de
  retard), son établissement (raison sociale, SIRET, TVA, adresses ; les corrections se font dans « Mon compte »), **ses tarifs** (prix
  hors taxes en vigueur et depuis quand ; l'ancien prix et le prochain tarif programmé s'y lisent s'il y en a), ses **devis** finalisés
  (jamais les brouillons) avec leur PDF, et les **documents** déposés par la blanchisserie (voir « Documents du contrat »). L'IBAN du
  mandat n'est jamais renvoyé.
- **Livraisons** : l'historique des bons de livraison (commandes livrées), du plus récent au plus ancien, groupés par mois, avec filtre par
  mois, recherche par numéro et filtre « à facturer / facturées ». Chaque bon se déplie : date de collecte et de livraison, pour chaque
  article la quantité commandée et la quantité livrée (écarts signalés), les reprises de linge, le PDF du bon et « Commander à nouveau ».
  Aucun montant n'y figure (ils sont sur les factures) ; une livraison facturée indique le numéro de la facture. Le PDF d'un bon n'est servi
  qu'à l'hôtel concerné.
- **Mon compte** : voir plus bas.

- **Factures (détail)** : pour chaque facture de la facturation intégrée, le statut (à régler, réglée en partie, en retard, réglée, avoir),
  l'échéance, le montant TTC, le reste dû et le PDF. Un résumé « Reste à régler » (dont le retard) surmonte la liste, avec les
  coordonnées bancaires et un bouton « Copier ». Tant que l'offre d'**escompte** est ouverte, un encadré indique le montant à payer
  et la date limite ; une fois la facture réglée avec escompte, l'escompte accordé est rappelé. Les anciennes factures du circuit
  Odoo restent listées (sans statut). Filtres « Toutes / À régler / Payées ».
- **Recommander** : sur une commande livrée, reprend ses quantités dans le formulaire de commande (rien n'est envoyé : l'hôtel vérifie
  puis valide). Les articles qui ne sont plus au catalogue de l'hôtel sont signalés et ignorés.
- **Mon compte (détail)** : coordonnées (contact, téléphone, adresse), informations de facturation (SIRET, TVA, adresse de facturation) et
  changement du code d'accès. Le nom de l'établissement reste géré par Blanchisserie Cézanne (il figure sur les factures) ; changer
  l'adresse e-mail (l'identifiant) exige le code actuel. Chaque modification de coordonnées ou de code est tracée au journal de la
  facturation (`client_self_updated`, `client_code_changed`).
- **Code oublié** : l'hôtel saisit son adresse e-mail et reçoit un lien valable 1 heure, utilisable une seule fois. La réponse est la même
  que le compte existe ou non. Le jeton (256 bits) n'est stocké qu'empreinté (SHA-256) et le lien est toujours construit à partir de
  `PUBLIC_URL` (sinon `RENDER_EXTERNAL_URL`, que Render fournit), jamais de l'en-tête `Host`. Sans envoi d'e-mails configuré
  (`SMTP_*`) ou sans adresse publique, la fonction est indisponible : l'écran affiche alors le téléphone et l'e-mail de la blanchisserie
  (réglages de la facturation).
- **Essais limités** : 5 mauvais codes pour une même adresse e-mail bloquent la connexion 15 minutes (même avec le bon code), de même
  pour les changements de code et les demandes de lien. Ces compteurs sont en mémoire : un redémarrage du serveur les remet à zéro.
  Ils sont suivis par adresse et non par IP, car le serveur n'est pas configuré derrière un proxy de confiance.

### Documents du contrat (contrat signé, CGV)

La blanchisserie dépose des PDF que l'hôtel retrouve dans l'onglet « Contrat » de son espace :

- **Par hôtel** : Facturation → Hôtels → fiche de l'hôtel → onglet **Contrat** (« Ajouter un PDF… » : type *Contrat signé* ou *Avenant, annexe ou
  autre document*, titre affiché à l'hôtel, date de signature facultative). Visibles uniquement par cet hôtel ; le contrat signé s'affiche en premier.
- **Communs à tous les hôtels** (conditions générales de vente…) : Facturation → Émetteur, bloc « Conditions générales et documents communs »
  (également sous l'onglet Contrat de chaque fiche hôtel). Ajoutés ou retirés une fois, ils changent pour tous.
- Règles : PDF uniquement (le contenu est vérifié, pas seulement l'extension), 8 Mo au plus, 30 documents au plus par hôtel. Le fichier est
  stocké dans la base (table `client_documents`) : il est donc inclus dans chaque sauvegarde et supprimé avec l'hôtel. Dépôt, modification et
  suppression exigent la Facturation déverrouillée ; chaque dépôt et suppression est tracé au journal (`client_document_added` / `_removed`).
- Pour remplacer un fichier : déposer le nouveau puis supprimer l'ancien.
- Routes (administration, sous `/api/admin/billing/catalog`) : `GET/POST clients/:id/documents`, `GET/POST documents/common`,
  `PUT/DELETE documents/:docId`, `GET documents/:docId/file`. Le PDF voyage tel quel dans le corps de la requête
  (`Content-Type: application/pdf`) ; titre, type, nom de fichier et date dans l'adresse (`?kind=&title=&filename=&signedOn=`).
- Routes (hôtel connecté, sous `/api/clients`) : `GET deliveries`, `GET deliveries/:id/pdf`, `GET contract`, `GET documents`,
  `GET documents/:id`, `GET quotes/:id/pdf`. Un document, un bon ou un devis qui n'est pas celui de l'hôtel connecté répond 404 ; un devis
  brouillon aussi.

## Facturation intégrée

Moteur de facturation natif (onglet **Administration → Plus → Facturation**).
Il remplace entièrement le circuit Odoo : toute la facturation passe par lui.
La génération de factures via Odoo est désactivée (l'ancienne route répond 410) ;
le code Odoo est conservé, inactif, et l'historique des factures déjà créées via
Odoo reste en base et téléchargeable par les hôtels dans leur espace.

### Ce que couvre l'espace Facturation

| Page | Rôle |
|---|---|
| Tableau de bord | encours avec ruban d'ancienneté, facturé/encaissé du mois, délai moyen de paiement, « à faire », 12 mois |
| Factures | liste à onglets (brouillons, à encaisser, en retard, payées, avoirs), recherche, tri ; tiroir de détail (aperçu PDF, détail, historique) |
| Bons de livraison | les commandes livrées, filtrées par **période** et par **hôtel** (plus recherche et état de facturation) ; détail d'un bon, PDF d'un bon ou de tous les bons filtrés (un seul fichier), export Excel (CSV) |
| Devis | brouillon → finalisé (`DE-AAAA-NNNN`, valable 30 j) → accepté / refusé → converti en brouillon de facture |
| Facturer le mois | un brouillon par hôtel pour tous les bons livrés non facturés, vérification, émission groupée |
| Hôtels | fiche de chaque hôtel : coordonnées, SIRET/TVA, tarifs négociés, catalogue accessible, jetons d'API et webhook |
| Articles | catalogue (prix, codes Sage, dimensions pour la logistique), impact d'un changement de prix, import CSV |
| Tarifs par hôtel | grille articles × hôtels, modification d'un tarif en un clic, import/export CSV, journal des changements |
| Règlements | tous les encaissements ; **règlement en lot** de plusieurs factures d'un coup |
| Prélèvements SEPA | mandats par hôtel, préparation d'un fichier de prélèvement pour la banque, suivi jusqu'à l'encaissement |
| Rapprochement bancaire | import d'un relevé CSV, propositions de factures, **mode de règlement choisi ligne par ligne**, validation ligne par ligne ; une empreinte par ligne empêche tout double enregistrement |
| Relances | factures échues, niveau conseillé (rappel / relance / dernier rappel), texte prêt ; **toujours déclenchées par une personne** |
| Émetteur, Sécurité et sauvegardes, Pennylane, Contrôle et FEC | configuration |

**Avant la première facture** : renseigner Facturation → Émetteur (raison
sociale, forme, capital, SIREN, RCS, n° de TVA, IBAN). L'émission est refusée
tant qu'une mention obligatoire manque, et la fiche de chaque hôtel doit avoir
un SIREN/SIRET valide (obligatoire sur les factures B2B depuis le 1er sept. 2026) — sauf les clients **particuliers**, voir plus bas.

### Principes du moteur

- montants calculés en **centimes entiers** ; TVA calculée par taux sur la base HT ;
- brouillon librement modifiable → **émission** = numéro continu (`FA-AAAA-000001`),
  empreinte SHA-256 chaînée, identités vendeur/acheteur figées ;
- une facture émise **ne peut plus être modifiée ni supprimée** (triggers SQL,
  y compris depuis la console SQLite) : correction par **avoir**, partiel ou total ;
- règlements, journal d'événements et historique d'e-mails en **ajout seul**
  (annulation d'un règlement = écriture inverse) ;
- PDF régénéré à l'identique depuis les données figées ; visible dans l'espace client ;
- Contrôle et FEC : vérification d'intégrité (empreintes, chaînage, totaux, numérotation,
  journal) + export **FEC**.

### Articles, hôtels et tarifs

Le catalogue d'articles, les fiches hôtels et les tarifs négociés se gèrent **dans la
Facturation**, donc derrière son code : ce sont les données qui déterminent ce qui est facturé.
Les anciens écrans « Gestion des articles » et « Gestion des clients » de l'administration et leurs
routes (`/api/admin/articles` hors logistique, `/api/admin/clients/:id/...`) ont été supprimés ; ils
répondent 404. L'onglet **Chariots et camions** (types de chariots, de camions) reste dans
l'administration ; la création rapide d'un hôtel depuis « Nouvelle commande » aussi.

**Règles de prix**

- chaque article a un **prix catalogue** (HT, 3 décimales) ; un hôtel paie ce prix, sauf là où il a un **tarif négocié** ;
- un tarif négocié a une **date d'effet** (aujourd'hui, le 1er du mois, ou toute date) ; il ne s'applique
  jamais avant. Un nouveau tarif clôt le précédent la veille de sa date ; les périodes ne se chevauchent jamais ;
- le prix est **figé sur la commande à sa création**, puis **mis à jour automatiquement** quand le tarif négocié change :
  tout changement de tarif (modification d'un prix, retour au catalogue, import CSV, opération en masse) recalcule les
  **BL non facturés** de l'hôtel dont la date (livraison prévue, sinon création) est égale ou postérieure à la date d'effet,
  pour les seuls articles touchés. Un **BL déjà facturé ne change jamais** ; un BL **déjà dans un brouillon de facture** est
  laissé tel quel et **signalé** (supprimez le brouillon puis recréez-le pour qu'il reprenne le nouveau tarif) ;
- les BL non facturés **datés d'avant la date d'effet** ne sont pas touchés, mais ils sont **annoncés** (nombre, date du plus ancien)
  dans l'aperçu et dans le message de confirmation, avec un bouton pour reprendre la date du plus ancien (modification d'un prix,
  opération en masse) ; la fenêtre de modification d'un prix et « Réappliquer aux BL non facturés » proposent aussi « depuis le BL
  non facturé le plus ancien ». Attention : un BL facturé hors du logiciel (Sage) apparaît comme non facturé ;
- l'impact (nombre de BL et de lignes, écart en euros) est **affiché dans l'aperçu avant validation** (import, opérations en
  masse) et rappelé dans la confirmation ; il est écrit dans le journal chaîné (`orders_repriced`, avec `via` = `import` ou `tarif`). Dans l'import, la case « Mettre à jour aussi
  les BL non facturés » est cochée par défaut et peut être décochée ;
- un changement du **prix catalogue** ne recalcule rien (le catalogue n'a pas d'historique) : l'action explicite
  « Réappliquer aux BL non facturés » (fiche de l'hôtel) reste là pour ce cas, ou pour une autre date de départ ;
- le **catalogue accessible** d'un hôtel est soit complet (y compris les futurs articles), soit une sélection d'articles ;
- le tarif négocié s'applique partout où une commande se crée : espace client, commande saisie, import par API
  **et génération depuis le planning des chambres** (qui utilisait jusqu'ici le prix catalogue : corrigé) ;
- toute modification de prix, de catalogue accessible ou de recalcul est écrite dans le **journal chaîné** de la
  Facturation (contrôlé par « Contrôle et FEC ») et consultable par article ou par hôtel.

**Opérations en masse** — pourcentage (sur le prix actuel ou le prix catalogue, sur tout ou une sélection d'articles),
copie des tarifs d'un autre hôtel, retour au catalogue, import CSV (articles, hôtels, tarifs). Chacune affiche d'abord un
**aperçu exact** (le même calcul que l'application, simplement annulé) puis demande le code pour appliquer.
Les CSV acceptent `;` ou `,`, la virgule décimale, l'UTF-8 (avec ou sans BOM) et le format Excel Windows.

**Import de tarifs en liste** (colonnes `client`, `code_sage`, `prix`, facultativement `date_debut` et `siret`) — l'hôtel et l'article
sont retrouvés avec tolérance, sans jamais deviner en silence :
- **hôtel** : nom identique à une fiche (accents et casse ignorés) ; sinon **SIRET/SIREN** de la colonne `siret` s'il n'appartient qu'à
  une seule fiche ; sinon la ligne reste en erreur et l'aperçu propose les **fiches les plus proches** (même méthode que le regroupement
  des BL à nom libre). Pour chaque hôtel non reconnu, on choisit la fiche dans une liste (ou « ignorer »), puis « Revérifier » ; le
  choix prime sur le SIRET, jamais sur un nom identique. Rien n'est choisi d'office ;
- **article** : code Sage identique, sinon comparaison sans les espaces (« B- TAPIS » = « B-TAPIS ») sauf si deux articles ne se
  distinguent que par leurs espaces ;
- le journal chaîné note comment chaque hôtel a été retrouvé (`hotelMatch` : `siret` ou `choix`).
- **date d'effet** : chaque ligne prend sa `date_debut`, sinon la « date d'effet par défaut » de la fenêtre. La case **« Utiliser cette date pour
  toutes les lignes »** impose la date de la fenêtre à toutes les lignes (la colonne `date_debut` est ignorée) : pratique quand tous les
  hôtels doivent partir du même jour (par exemple le 28/09 pour que tous les BL non facturés depuis cette date reprennent les tarifs).

### Bons de livraison

Page **Facturation → Bons de livraison** (juste sous « Factures »). Un bon de livraison (BL) est une commande au
statut « Livrée » ; sa date est la date de livraison prévue, à défaut la date de création (la même qui sert à facturer
et à choisir le tarif en vigueur).

- **Filtres** : période (du / au, bornes incluses, avec « Ce mois-ci », « Mois dernier », « 30 derniers jours »),
  hôtel, recherche (numéro de bon, nom d'hôtel) et état de facturation. Les onglets *À facturer / Dans un brouillon /
  Facturés* affichent leur nombre ; le total HT de la sélection s'affiche au-dessus du tableau ;
- **État de facturation**, calculé comme « Facturer le mois » : *à facturer*, *dans un brouillon*, *facturé* (avec le numéro
  de facture), *facturé (ancien circuit)* pour l'historique Odoo. Une facture annulée par un avoir total remet le BL à facturer ;
- **Paiement de la facture** : pour un BL facturé, une pastille *À encaisser / En retard / Partielle / Payée* (mêmes règles que la liste
  des factures : l'échéance passée prime sur un règlement partiel) et, sous les onglets, des puces *Paiement* cumulables avec leur nombre
  (paramètre `payment=unpaid,overdue,partial,paid`). Chaque rangée de puces compte en tenant compte de l'autre (onglet de facturation ↔
  puces de paiement). Un BL à facturer, en brouillon ou facturé dans l'ancien circuit n'a pas de paiement à suivre. Le CSV a une colonne
  `paiement` et respecte le filtre ;
- **Montants** : quantité livrée × prix figé sur la commande. Un bon dont la quantité livrée diffère de la commande est signalé ;
- **Quantités livrées** : la facture reprend la quantité **livrée**, jamais la commandée. À la création d'une commande la quantité
  livrée est pré-remplie avec la commandée ; si la livraison est incomplète, « Corriger les quantités livrées » (fiche du BL, tant qu'il est
  *À facturer*) ou le champ « livré » de la fiche commande (en traitement, prête ou livrée) la rectifient, la quantité commandée ne bouge
  jamais. Dès que la commande est dans un brouillon ou une facture, les quantités sont **figées** (refus 409) : supprimer le brouillon, ou
  émettre un avoir total, les rend à nouveau modifiables. Une correction faite après la préparation est inscrite au journal de facturation
  (`delivered_qty_changed`). « + Ajouter un article » sur un article déjà présent garde la quantité livrée déjà saisie ;
- **Exports** : PDF d'un bon, **PDF groupé** de tous les bons filtrés (un bon par page, du plus ancien au plus récent,
  500 bons au plus) et CSV Excel (`;`, virgule décimale, BOM) ;
- depuis la fiche d'un hôtel, « Voir ses bons de livraison » ouvre la page déjà filtrée.

La page ne modifie ni commande ni facture, hormis la correction des quantités livrées ci-dessus. Elle est derrière le code de la Facturation.

### Restreindre des articles aux hôtels qui les utilisent

Deux façons de régler la même chose (un hôtel voit tout le catalogue ou seulement une sélection) :

- **depuis l'article** (Facturation → Articles → fiche de l'article → « Hôtels qui peuvent le commander ») : la liste de
  tous les hôtels, chacun avec son usage sur 12 mois (pièces, dernière commande). Cocher / décocher, chercher un hôtel,
  « Décocher ceux qui ne l'ont pas commandé depuis 12 mois ». L'enregistrement affiche d'abord un **aperçu** : hôtels qui perdent
  l'article (avec un avertissement s'ils l'ont commandé récemment), hôtels qui passent en « catalogue sélectionné », hôtels
  qui le retrouvent. La colonne « Proposé à » du tableau des articles indique à combien d'hôtels il est retiré ;
- **depuis l'hôtel** (fiche de l'hôtel → Catalogue accessible) : en passant à « Seulement une sélection », tous les articles sont
  cochés au départ ; l'usage sur 12 mois est affiché à côté de chaque article, avec « Décocher les articles jamais commandés ».

Règles : retirer un article à un hôtel qui voyait tout le catalogue le passe en *sélection* (il garde tous les autres articles actuels,
mais pas les futurs) ; lui redonner tous les articles le ramène à *catalogue complet*. **Un hôtel ne peut jamais se retrouver sans
aucun article** (la demande est refusée en entier). Les commandes déjà passées, les BL et les factures ne changent pas ; la génération
de commandes depuis le planning des chambres continue d'utiliser le catalogue complet. Chaque changement est écrit dans le journal chaîné
(`client_article_access`) et visible dans l'historique de l'article comme dans celui de l'hôtel.

### Règlements en lot et mode de règlement

- **Rapprochement bancaire** : chaque ligne du relevé propose un mode de règlement (*prélèvement* détecté d'après le libellé
  `PRLV` / `SEPA`, sinon virement, chèque…), modifiable avant validation. Une valeur inconnue est refusée au lieu d'être remplacée
  en silence.
- **Règlements en lot** (Facturation → Règlements) : on coche des factures ouvertes, on indique date, mode et référence ; un
  **aperçu** exact s'affiche, puis l'enregistrement demande le code (`payments-bulk`). Tout ou rien : si une facture est refusée
  (déjà soldée, montant dépassé…), aucun règlement du lot n'est enregistré.

### Liste des factures : filtres de statut, affichage compact

Facturation → Factures : des puces cliquables filtrent par statut, **plusieurs à la fois** (union) :
Brouillons, À encaisser (émise, rien reçu, pas échue), En retard, Partielles (règlement partiel, échue ou non), Payées
(y compris soldées par avoir) et Avoirs. Chaque puce affiche son nombre (et son montant) ; « Toutes » remet tout.
La recherche, l'hôtel et les dates se combinent avec les statuts, et une ligne de synthèse donne le nombre de factures, le total TTC
et le reste à encaisser de la sélection. L'API accepte `GET /invoices?status=overdue,partial` (l'ancien `tab=` fonctionne encore).

**Cases à cocher et export** : chaque ligne de la liste a une case (la case de l'en-tête coche toutes les lignes affichées). Une barre
indique le nombre de documents cochés et leur total TTC, avec **« Exporter en PDF (un par facture) »** : le navigateur télécharge une archive
ZIP (`factures-AAAA-MM-JJ.zip`) qui contient un PDF par facture ou avoir, nommé par son numéro (`FA-2026-000012.pdf`), identique au PDF
téléchargé depuis la facture. Seuls les documents **émis** se cochent (un brouillon n'a pas de PDF définitif) ; 200 documents au plus par export ;
une ligne cochée qui disparaît de la liste (recherche, filtre) est décochée : on n'exporte que ce que l'on voit. L'export est inscrit au journal
de facturation (`invoices_exported`). API : `GET /invoices/export.zip?ids=1,2,3`.

**Nouvel avoir** : un bouton en haut de la liste des factures (et sur le tableau de bord) fait choisir l'hôtel puis, parmi ses factures émises
non entièrement créditées, celle à créditer ; la fenêtre habituelle « Créer un avoir » s'ouvre alors (motif, avoir total ou partiel par
quantités, confirmation par le code de la Facturation). L'avoir est créé en **brouillon**, vérifié puis émis comme une facture. Le même
parcours reste disponible dans le tiroir de chaque facture (« Créer un avoir… »). Un avoir se rattache toujours à une facture émise.

Pour afficher un maximum de factures : lignes sur une seule ligne en police 13 px, tableau qui occupe toute la hauteur de l'écran
(en-têtes fixes, défilement dans le tableau), bandeau « File de production » réduit dans la Facturation.
Le menu **Bons de livraison** est masqué par défaut ; le lien discret « Afficher les bons de livraison » sous le menu le
réaffiche (choix mémorisé dans le navigateur), et la page reste accessible depuis la fiche d'un hôtel.

Dans le menu de gauche, **Encaissements** et **Configuration** sont des titres sur lesquels on clique pour dérouler ou replier leurs
sous-menus. Ils sont repliés par défaut ; le choix est mémorisé dans le navigateur, et ouvrir une page d'un groupe replié (lien,
raccourci du tableau de bord) le déroule. Replié, « Encaissements » affiche le nombre de relances à faire. Sur mobile, le menu reste
une rangée horizontale avec tous les liens.

### Typographie de l'administration

Tous les onglets d'administration (Production, Préparation de commande, Logistique, Statistiques, Historique, Chariots et camions, Garage,
Réglages) et les fenêtres de commande reprennent la typographie de la Facturation : texte et boutons en IBM Plex Sans (graisse moyenne,
minuscules), Fredoka réservé aux titres (600) et aux chiffres, plus de capitales espacées. Les règles sont regroupées à la fin de
`public/styles.css` (« Onglets d'administration »), limitées à `#admin-dashboard` et aux fenêtres de commande : l'espace client et la
Facturation (styles `.bl-*`) ne sont pas touchés.

### Clients particuliers (sans SIRET)

Chaque fiche a un **type de client** : *Professionnel* (par défaut) ou *Particulier* (Facturation → Hôtels → Nouveau client, ou
dans la fiche, section « Facturation » ; colonne facultative `type` à l'import CSV : `professionnel` / `particulier`, cellule vide
= inchangé, ou professionnel pour un nouveau client).

- **Pas de SIRET ni de n° de TVA** : les champs sont masqués (fiche et espace client) et toute valeur saisie est écartée ; l'émission d'une
  facture ne les exige pas. Un professionnel sans SIRET reste refusé à l'émission.
- La facture figée porte `buyer.type = "particulier"` : pas de SIREN, **pas d'indemnité forfaitaire de 40 €** (art. D441-5 : elle ne vise
  que les relations entre professionnels) ni sur le PDF, ni dans les conditions figées, ni dans les relances 2 et 3 par e-mail.
- **Escompte** : non proposé par défaut à un particulier, même si l'escompte est activé pour tous ; seulement si sa fiche le demande (« Oui »).
- **Adresse postale et e-mail facultatifs** : un particulier peut être créé (fiche, import CSV) et facturé avec son seul nom. Sa fiche n'est
  jamais signalée « à compléter » pour une adresse, et ni la facture ni le devis ne la réclament (le PDF omet simplement le bloc d'adresse).
  Dans l'import CSV, les cellules `adresse` et `email` d'une ligne particulier peuvent rester vides (les colonnes doivent exister) ; un
  particulier sans e-mail est retrouvé par son nom au réimport, et une cellule d'adresse vide n'efface pas l'adresse déjà connue. Connecté,
  un particulier peut aussi enregistrer son profil et passer commande sans adresse de collecte. Pour un professionnel, rien ne change :
  adresse et e-mail restent exigés. Sans e-mail, pas d'espace client ni d'envoi automatique des factures ; sans adresse, la commande
  n'est pas placée dans les tournées (elle apparaît parmi les adresses non localisées).
- Les factures déjà émises ne changent jamais : changer le type d'une fiche n'a d'effet que sur les documents suivants.

### 2e destinataire des envois

La fiche client porte un seul **e-mail** : c'est l'identifiant de connexion à l'espace client, il est unique et ne peut contenir qu'une adresse.
Un champ facultatif **« 2e destinataire »** permet d'ajouter une adresse de plus (comptabilité, direction…) :

- elle est proposée avec la première dans la fenêtre d'envoi des factures, devis, bons de livraison et relances (« adresse1, adresse2 »),
  que l'on peut toujours modifier avant d'envoyer (jusqu'à 5 destinataires par envoi) ;
- elle ne donne **pas** accès à l'espace client et peut être la même pour plusieurs fiches ;
- une seule adresse valide, différente de l'e-mail principal, et seulement si l'e-mail principal est renseigné ;
- Pennylane et Odoo ne reçoivent que l'e-mail principal ; l'import CSV ne gère pas ce champ.

### Clients suisses (n° IDE à la place du SIRET)

Dans le champ « SIRET » de la fiche (et de l'espace client), une entreprise suisse saisit son **n° IDE** (aussi appelé UID) : `CHE-123.456.789`.
Les écritures courantes sont acceptées (`CHE123456789`, `che 123 456 789`, suffixe `TVA` / `MWST` / `IVA`) et enregistrées sous la forme
`CHE-123.456.789`. Sa **clé de contrôle** (9e chiffre, modulo 11) est vérifiée : un numéro faux est refusé à la saisie.

- La fiche n'est plus « à compléter » pour un SIRET, et l'émission d'une facture n'exige pas de SIREN : ses 9 chiffres ne sont jamais pris
  pour un SIREN français. Un professionnel sans aucun identifiant reste refusé.
- La facture figée porte `buyer.uid` et `buyer.country = "CH"` (clés écrites seulement pour un client suisse : les documents des autres clients
  restent identiques) ; le PDF ajoute « Suisse » et « N° IDE CHE-… » sous l'adresse, sans ligne SIREN. Pennylane reçoit le pays `CH`.
- **Rien d'autre ne change pour l'étranger** : la TVA reste calculée comme pour un client français (20 %) et l'indemnité de 40 € reste mentionnée.
  Le traitement de la TVA d'un client suisse est à valider avec l'expert-comptable.

### Export FEC sur une période

Facturation → Contrôle et FEC : choisir *Année en cours*, *Année précédente*, *Mois en cours*, *Mois dernier* ou *Dates au choix*
(bornes incluses). Un aperçu indique, avant tout téléchargement, le nombre de factures, d'avoirs et de règlements repris, et le nombre de
brouillons ignorés.

- **Seuls les documents validés (émis)** sont repris — factures et avoirs ; un brouillon n'a ni numéro ni date d'émission et n'apparaît jamais.
- Règlements et escomptes : ceux dont la **date** tombe dans la période, rattachés à une facture émise (un règlement d'octobre sur une
  facture de septembre figure dans le FEC d'octobre, pas la facture).
- Numérotation des écritures continue **depuis 1** dans le fichier ; débit = crédit (sinon l'export est refusé). Nom du fichier :
  `SIRENFECAAAAMMJJ.txt`, avec la date de fin de période. Période vide ou invalide : refusée avec un message.
- Le code de la Facturation est redemandé pour la période exacte demandée (`fec:AAAA-MM-JJ_AAAA-MM-JJ`) ; `?year=AAAA` reste accepté.
- Un FEC partiel sert à un échange avec le comptable ; pour un contrôle fiscal, exporter l'exercice complet.
- API : `GET /api/admin/billing/export/fec?from=AAAA-MM-JJ&to=AAAA-MM-JJ` et `…/export/fec/preview` (mêmes paramètres).

### Dupliquer une commande

Dans la fiche d'une commande (Préparation, Production, Historique…), **Gestion de la commande → Dupliquer la commande** ouvre le formulaire
de création **prérempli** : même client, mêmes articles et **quantités commandées** (pas les quantités livrées), note « Copie de la
commande CZ-… ». On choisit la date de livraison, on ajuste si besoin, puis « Créer » : nouveau ticket, statut *Reçue*, **tarifs du jour**
(un tarif négocié récent s'applique). Les articles qui ne sont plus au catalogue ou plus attribués au client sont **signalés** dans le
formulaire, jamais repris en silence. La commande d'origine n'est pas modifiée. API : `GET /api/admin/orders/:id/copy`.

### Escompte pour règlement anticipé

Une remise accordée à l'hôtel qui paie vite (par exemple **1,5 % pour un règlement sous 48 h**). Éteint par défaut.

- **Réglages** (Facturation → Coordonnées de l'émetteur → « Escompte pour règlement anticipé ») : taux (0 = aucun escompte, 10 % au plus),
  délai en heures à compter de la date d'émission (48 h = règlement reçu au plus tard 2 jours après), et « tous les hôtels par défaut ».
  Chaque **fiche hôtel** peut déroger : *selon le réglage général*, *toujours proposé* ou *jamais proposé*.
- **Sur la facture** : à l'émission, l'offre (taux, date limite, montants HT / TVA / TTC) est **figée** dans les conditions de la facture,
  donc dans son empreinte : changer ensuite le réglage ne touche pas les factures déjà émises. Elle apparaît dans un encadré du PDF
  et dans les mentions légales, avec la phrase exigée : « seule la TVA correspondant au prix effectivement payé ouvre droit à
  déduction chez l'acheteur ». Pas d'offre sur un avoir, ni si la date limite n'est pas antérieure à l'échéance. Le message d'envoi par
  e-mail rappelle l'offre tant que la date limite n'est pas passée.
- **À l'encaissement** : « Enregistrer un règlement » propose la case *avec escompte* (cochée par défaut dans le délai). Le montant à
  recevoir est exact au centime (reste dû − escompte) ; hors délai la case est grisée et le moteur refuse. L'escompte s'enregistre comme
  une ligne de règlement de mode *escompte*, à côté du virement : la facture est soldée, l'**argent reçu** reste le net. Le rapprochement
  bancaire reconnaît un virement égal au net, arrivé à temps, et l'enregistre « avec escompte ». Si un avoir ou un règlement partiel est
  intervenu avant, l'escompte est calculé sur le **reste dû**.
- **Annulation** : annuler le règlement propose d'annuler aussi l'escompte (la facture se rouvre pour son montant complet) ; sinon
  l'escompte reste acquis. L'écriture inverse est plafonnée à l'argent réellement reçu.
- **Comptabilité** : l'escompte réduit la base de TVA (art. 267-II-1° du CGI). Il est ventilé en HT et TVA taux par taux. Dans le FEC il passe
  en journal **OD** : débit 665000 *Escomptes accordés* (HT) et TVA collectée, crédit du compte client (TTC) ; le journal de banque ne
  compte que l'argent reçu. Comptes à valider avec votre expert-comptable (`ACCOUNTS.discountGranted` dans `src/billing/fec.js`).
- **Statistiques** : l'escompte n'est jamais compté comme encaissé (tableau de bord, journée, liste des règlements : il est affiché à part).

### Bons de livraison : sélection et format de facture

Chaque ligne de la liste des BL a une **case à cocher** (la case de l'en-tête coche toute la liste affichée). Une barre propose alors
**« Télécharger la sélection (PDF) »** (un seul PDF, un bon par page) et **« Exporter la sélection (Excel) »** pour ces seuls BL, quels que soient
les filtres (`GET /deliveries/export.pdf?ids=…` et `export.csv?ids=…`, 500 BL au plus). La colonne **Format** donne le niveau de détail de
la facture : *Détaillé* (une ligne par article et par BL), *Par BL* (une ligne par bon) ou *Regroupé* (une ligne par article sur la période). C'est
le format de la **facture** (brouillon ou émise) quand le BL y figure, sinon celui de la **fiche de l'hôtel** (appliqué à la prochaine facture) ;
« — » pour un BL facturé dans l'ancien circuit. L'export Excel gagne une colonne `format_facture`.

### Équipe (RH) et badgeuse

Administration → **Équipe** (fichiers : `src/routes/rh.js`, `src/routes/badgeuse.js`, `src/utils/rh.js`, `src/utils/rhStore.js`, `public/rh.js`,
`public/badgeuse.*`). Cinq onglets :

- **Présence** — qui est là en ce moment, rangé par BU puis par machine (se rafraîchit toutes les 30 s). Une pastille rouge sur
  **Heures** signale les pointages à corriger.
- **Collaborateurs** — fiche : prénom, nom, fonction, contrat, heures par semaine, coût horaire chargé (facultatif),
  **rattachement** (une machine, qui impose sa BU, ou une BU entière), code personnel (4 à 6 chiffres) et badge. Un collaborateur
  n'est jamais effacé (ses heures font partie de l'historique) : il est **archivé** et peut être réactivé.
- **Heures** — période (semaine, mois ou dates libres) : total, répartition par BU, grille collaborateur × jour, heures au-delà du
  contrat (par semaine, lundi → dimanche) et alerte au-delà de 48 h, heures et coût de main-d'œuvre **par machine**, liste des
  pointages (ajout, correction, suppression). Exports CSV pour Excel (`;`, BOM, virgule décimale) : récapitulatif par
  collaborateur et détail des pointages. Les cellules qui ressembleraient à une formule sont neutralisées.
- **Machines** — nom, BU, capacité. Parc de départ posé une seule fois (3 laveuses 27/27/33 kg, 2 séchoirs 18 kg, 2 calandres) tant que
  l'équipe est vide. Une machine déjà utilisée est retirée sans effacer l'historique ; changer sa BU déplace ceux qui y sont rattachés.
- **Badgeuses** — une tablette = un jeton (64 caractères, **montré une seule fois**, seule son empreinte est conservée), révocable.

BU : Lavage, Séchage, Finition, Logistique, Administratif (liste dans `src/utils/rh.js`). Un « poste » est une machine ou une BU entière.

**Tablette de l'atelier** (`/badgeuse`, plein écran, gros boutons) : créer la tablette dans Équipe → Badgeuses, ouvrir le **lien
d'activation** sur la tablette (le jeton est dans la partie « # » de l'adresse, qui n'est jamais envoyée au serveur, puis effacée de
l'adresse). On touche son prénom, on saisit son code, puis **Arrivée** (au poste de son rattachement ou ailleurs), **Changer de
poste**, **Pause** ou **Départ**. Un lecteur de badge USB « clavier » fonctionne sans réglage (le numéro est lu comme une frappe
rapide terminée par Entrée ; seule son empreinte est stockée). L'écran revient à l'accueil après 25 s sans action.

Règles :
- l'heure fait foi côté serveur ; chaque changement de poste ferme un tronçon et en ouvre un autre (`time_entries`, instants en UTC,
  jours et semaines calculés à l'heure de Paris) ;
- code faux : 5 essais puis blocage de 15 min (doublé à chaque récidive), **par collaborateur** (pas par adresse), journalisé dans
  le journal de sécurité ; l'administrateur débloque depuis la fiche ;
- **badge oublié** : un tronçon resté ouvert depuis la veille (ou plus de 16 h) ne compte pas comme du temps travaillé ; au pointage
  suivant il est refermé pour une durée nulle, signalé « à corriger » et le collaborateur peut pointer normalement ; l'administrateur
  renseigne l'heure de fin dans Heures ;
- les pointages saisis ou corrigés à la main sont marqués « Manuelle » / « corrigé » ; ils ne peuvent ni chevaucher un autre pointage
  du même collaborateur ni se situer dans le futur ;
- aucune donnée de salaire n'est exposée à la tablette ; le coût horaire n'apparaît que dans l'administration.

### Atelier (production : lots, machines, heures, coût au kilo)

Administration → **Atelier** (fichiers : `src/utils/prodStore.js`, `src/routes/prod.js`, `src/routes/atelier.js`, `src/utils/rhAuth.js`,
`public/prod.*`, `public/atelier.*`). Il suit chaque **lot** de linge de la réception à la finition, machine par machine.

**Un lot** a un code `L-MMDD-NN` (numéroté par jour, heure de Paris), un type de linge, un statut (en cours, terminé, annulé) et passe
par trois étapes : **lavage → séchage → finition**. Chaque passage note la machine, le programme, le poids et les heures de début / fin
prévue / fin réelle. Les clients d'un lot : un seul (cas courant) ou **plusieurs** (lot mélangé, kilos par client facultatifs), chacun
pouvant être relié à une commande. Remarques, relavages et problèmes se rattachent au lot ; les pannes de machine sont à part.

**Tablette de l'atelier** (`/atelier`, même tablette et même jeton que la badgeuse : un lien d'activation `/atelier#<jeton>`, ou la tablette
déjà activée pour `/badgeuse`). Colonnes Lavage / Séchage / Finition avec les machines (en marche avec avancement et heure de fin
prévue, libre, en panne), « À reprendre » (lots attendant l'étape suivante) et « Lots du jour ». Créer un lot, lancer ou terminer
un passage, signaler une panne, ajouter une remarque : chaque action demande le **code personnel** du collaborateur (ou son badge),
gardé 90 s en mémoire du navigateur seulement ; 5 mauvais codes bloquent (même règle que la badgeuse).

**Onglets de l'administration** : *Aujourd'hui* (machines du jour, lots à reprendre, saisie manuelle d'un lot a posteriori),
*Lots* (recherche par période, statut, client), *Machines* (30 jours : passages, kilos, charge moyenne, utilisation, cadence réelle,
arrêts), *Heures* (par BU et par poste : heures, kilos, kg/h, coût, coût au kilo), *Tableau de bord* (coût au kilo comparé à
l'objectif, kilos par jour, main-d'œuvre par étape, utilisation, kilos par type de linge et par client), *Réglages* (objectif, prix
de l'eau et de l'énergie, tolérance de poids, horaires d'ouverture, programmes de lavage, types de linge). La cadence (kg/h) des
calandres se règle dans Équipe → Machines (départ : 45 kg/h pour 320 cm, 35 kg/h pour 250 cm).

Règles :
- une machine doit appartenir à l'étape (laveuse → lavage…), le poids ne dépasse pas sa capacité, et deux passages ne peuvent pas se
  chevaucher sur la même machine (ni une panne) ; un lot annulé libère ses machines ;
- fin prévue d'un lavage = durée du programme ; séchage et finition = poids ÷ cadence de la machine ;
- **passage oublié** : un passage resté ouvert depuis la veille (ou plus de 14 h) n'est pas considéré comme en marche ; quand la machine
  est réutilisée il est refermé et une note « problème » est ajoutée au lot ;
- un lot à un seul client sans poids explicite prend le poids du lot ; sur la fiche, le **poids attendu** (commande × poids d'article)
  est comparé au poids pesé, avec la tolérance réglée ;
- les saisies manuelles (jour passé) ne peuvent pas chevaucher un autre passage ni se situer dans le futur ;
- remarques et noms sont stockés bruts et **échappés à l'affichage** ; la tablette n'a accès à aucune donnée de salaire.

**Coût : ce qui est calculé et ce qui ne l'est pas.** Aucun chiffre n'est inventé : le coût d'un lavage = eau (litres du programme × prix
du m³) + énergie (kWh × prix du kWh) + lessive (programme) ; tant que le prix ou la consommation n'est pas renseigné, la ligne affiche
« à renseigner ». La main-d'œuvre vient des pointages : heures de chaque BU × coût horaire chargé, divisées par les kilos de l'étape
(collaborateurs sans coût horaire signalés). Le **coût au kilo** du tableau de bord = main-d'œuvre + consommables des lavages, comparé
à l'objectif (1,30 €/kg par défaut, modifiable). **Les consommations des séchoirs et des calandres ne sont pas incluses** (pas de
données) : le chiffre est donc un minimum, pas un coût complet. Période maximale d'un calcul : 92 jours.

API : tablette `/api/atelier/*` (jeton de tablette + code ou badge par action) ; administration `/api/admin/atelier/*`
(`overview`, `lots`, `steps`, `incidents`, `reference`, `settings`, `hours`, `stats`). Migrations : tables `lots`, `lot_clients`,
`lot_steps`, `lot_notes`, `machine_incidents`, `wash_programs`, `linen_types`, `prod_settings` et colonne `machines.throughput_kgh`,
créées au démarrage sans toucher aux données existantes ; aucun programme ni prix n'est pré-rempli.

### Présentation compacte des listes (factures, bons de livraison, Facturer le mois)

Ces trois écrans partagent la même présentation : lignes serrées (une ligne par document, nom d'hôtel tronqué avec infobulle), en-tête de
tableau toujours visible, **défilement dans le tableau** qui occupe la hauteur de l'écran sur ordinateur (sur téléphone, la liste défile avec la
page), puces de filtre et filtres sur une seule ligne. La hauteur est calculée par `Bill.fitList` (`public/billing/core.js`) ; une page qui
s'y adapte déclare `refit(main)` et se réajuste quand la fenêtre change de taille ou quand la barre de sélection apparaît.
- **Bons de livraison** : l'état de facturation (Tous, À facturer, Dans un brouillon, Facturés) et le paiement de la facture sont des puces
  comme dans la liste des factures ; les dates et les périodes rapides tiennent sur la même ligne que la recherche et l'hôtel.
- **Facturer le mois** : le tableau des hôtels prend la hauteur de l'écran, avec la barre de total (« 27 hôtels sélectionnés · environ … HT »)
  juste dessous. Un clic sur une ligne coche ou décoche l'hôtel (les lignes cochées sont surlignées ; la case de l'en-tête coche tout et passe en
  état intermédiaire quand la sélection est partielle). Les brouillons à émettre sont sous la liste : un bouton **« N brouillons à émettre »**
  en haut de page y descend, et la page y descend toute seule après « Préparer les brouillons ». Dans ce second tableau, un clic sur la case
  coche, un clic ailleurs sur la ligne (ou « Vérifier ») ouvre le brouillon.

### Regrouper les bons de livraison à nom de client libre

Certaines commandes ont été saisies avec un nom de client tapé à la main (pas de fiche hôtel). Facturation → Bons de livraison
les regroupe pour les rattacher à la bonne fiche :

- regroupement par **nom normalisé** (casse, accents, SAS/SARL, articles, pluriel, abréviations) ; la fiche hôtel proposée tient
  compte du nom, du téléphone et de l'adresse, et n'est jamais présentée comme « sûre » s'il existe un doublon possible ;
- **vérification bon par bon** : chaque regroupement se déplie, chaque BL peut être exclu avant d'appliquer ;
- **aperçu exact** (le même calcul que l'application, simplement annulé), possibilité de créer la fiche hôtel au passage ;
- option **recalculer les prix au tarif négocié** de l'hôtel (désactivée par défaut) ;
- le nom tapé sur chaque BL n'est **jamais modifié** ; les numéros de BL rattachés sont écrits dans le journal chaîné ;
  l'application demande le code (`orders-link`). **Il n'y a pas de bouton « annuler »** : une fois rattaché, un BL n'est plus dans la liste
  des « noms libres ». Le journal garde les numéros de BL de chaque rattachement, ce qui permet de les corriger ;
  vérifiez donc l'aperçu avant d'appliquer ;
- seuls les BL sans fiche hôtel sont concernés ; le recalcul des prix ne touche jamais un BL déjà facturé ni dans un brouillon.

### Tableau de bord journalier (Statistiques)

Onglet **Statistiques** de l'administration : **un seul filtre de dates en haut de page** (7 / 30 / 90 jours, ce mois-ci, mois dernier,
cette année, ou dates libres ; 400 jours au plus) qui s'applique à TOUS les blocs de la page. `GET /api/admin/stats?from=&to=` et
`GET /api/admin/stats/nps?from=&to=` : commandes, articles, statuts, top hôtels et top articles portent sur les commandes *reçues* dans la
période (heure de Paris) ; commandes livrées, poids et kilomètres sur les commandes *livrées* (date du BL) ; NPS sur les réponses de la
période. Sans dates, ces deux routes renvoient toute l'activité.
Le bloc « Articles les plus commandés » affiche aussi la **part de chaque article dans le volume total** (pièces commandées sur la période,
rapportées à l'ensemble des articles : `articlesTotalQty`) et le **prix unitaire HT moyen** de chaque article (moyenne pondérée par les quantités commandées sur la
période, reprises exclues ; une astérisque signale un prix qui a varié). C'est un montant : il vient de `GET /api/admin/billing/stats/articles`,
derrière le verrou de la Facturation — verrouillée, le bloc l'indique et propose de l'ouvrir. Tuiles de synthèse,
graphique jour par jour (au choix du chiffre affiché), tableau jour par jour avec détail dépliable (commandes reçues et livrées,
valeur, factures, règlements) et export Excel (CSV).

- **Exploitation** (commandes, pièces, poids, kilomètres, écarts commandé/livré) : `GET /api/admin/stats/daily`. Les commandes sont
  datées à l'heure de Paris à la réception, à la date du BL à la livraison.
- **Montants** (livré valorisé, facturé, avoirs, encaissé par mode de règlement, reste dû) : derrière le **verrou de la Facturation**.
  Sans le code, aucun montant n'est affiché ni envoyé par le serveur (`GET /api/admin/billing/stats/daily[/:date]`).
- Une annulation de règlement se voit dans la journée où elle est écrite.

### Répartition du linge (grand plat, petit plat, éponge, divers)

Dans **Statistiques**, sous « Activité jour par jour », le bloc **Répartition du linge** suit le même filtre de dates que le reste de la page
(« Ce mois-ci », « Mois dernier », dates libres…). Il donne, pour chaque famille, le **poids**, la **part du poids**, le nombre de
**pièces** et la **part des pièces** ; sur une période qui couvre plusieurs mois, un tableau **mois par mois** s'ajoute.
`GET /api/admin/stats/families?from=&to=` (`src/utils/linenFamilies.js`).

- **Périmètre** : le linge *livré* (commandes livrées, date du bon de livraison, quantité livrée si elle est connue, sinon commandée), comme
  le « Poids livré » de la page. Les reprises (quantités négatives) ne sont pas comptées.
- **Poids** : théorique, poids de la fiche article × quantité. Un article sans poids compte dans les pièces mais pas dans le poids (signalé).
- **Famille d'un article** : celle choisie dans sa fiche (Facturation → Articles → « Famille de linge », aussi visible dans la liste), sinon
  **proposée d'après le nom** — éponge (éponge, serviette de toilette, drap de bain, tapis de bain, peignoir, bain de soleil, SPA), petit plat
  (taie, traversin, serviette de table, torchon), grand plat (drap, housse de couette, nappe, alèse), sinon la catégorie « toilette » donne de
  l'éponge et le reste va en divers. **C'est une proposition à vérifier** : le bloc indique combien d'articles livrés n'ont pas de famille choisie
  et liste ce qui est rangé en Divers. Une ligne de commande dont l'article n'existe plus est classée d'après le nom figé dans la commande.
- Colonne `articles.linen_family` (vide = automatique), ajoutée au démarrage sans toucher aux données ; l'import CSV des articles ne la modifie pas.
- Correctif au passage : les barres des listes « Top hôtels » et « Articles les plus commandés » étaient invisibles (`.stats-row-bar-fill`
  n'avait pas `display:block`).

### Prélèvements SEPA

Facturation → **Prélèvements SEPA** (menu *Encaissements*). Le module prépare un fichier de prélèvement (norme
**pain.008.001.02**, accepté par les banques françaises) que vous remettez à votre banque ; il **n'envoie rien lui-même** et
n'enregistre aucun règlement avant que le prélèvement soit passé.

**Mise en place (une fois)** — bouton *Identifiant créancier et préavis* :
1. **ICS** (identifiant créancier SEPA) : à demander à votre banque (en France, de la forme `FR12ZZZ123456`) ; le module en vérifie le format.
2. Le nom et l'IBAN du créancier sont ceux de Facturation → Émetteur (raison sociale, IBAN, BIC).
3. **Préavis** avant chaque prélèvement : 14 jours par défaut, réglable.

**Mandats** (onglet *Mandats*) — un mandat est l'autorisation signée par l'hôtel :
- *Nouveau mandat* : hôtel, IBAN, BIC (facultatif), type **CORE** ou **B2B**, date de signature ; la **RUM** est proposée
  (`CEZ-0001-01`, 35 caractères maximum). Le IBAN est contrôlé (zone SEPA, longueur, clé modulo 97) ; l'enregistrement demande
  le code (`sdd-mandate`).
- *Formulaire à faire signer* : PDF au modèle européen (textes CORE ou B2B) prérempli avec les informations de l'hôtel.
- **Un seul mandat actif par hôtel.** Pour changer de compte : créer un nouveau mandat en cochant « remplace l'ancien » (l'ancien est
  révoqué). Un mandat n'est **jamais supprimé** (la loi demande de le conserver 14 mois après le dernier prélèvement) : on le révoque.
  Un mandat sans prélèvement depuis **36 mois** est signalé caduc et n'est plus utilisé.
- *Copie PDF* d'un mandat enregistré (code `sdd-copy:<id>`).

**Préparer et suivre un prélèvement** :
1. *À prélever* : factures émises encore ouvertes des hôtels qui ont un mandat actif, avec le montant restant dû (un règlement
   partiel ou un avoir est déduit) ; les hôtels **sans mandat** sont listés à part avec la raison.
2. Cocher, choisir la **date de prélèvement** (jour ouvré TARGET, au plus tôt le prochain jour ouvré, 90 jours au plus ; une date proposée
   à +3 jours ouvrés). Un **aperçu** montre le nombre de prélèvements, le total de contrôle, FRST ou RCUR pour chacun.
3. *Préparer le lot* (code `sdd-batch`) : un prélèvement **par hôtel** (les factures d'un même hôtel sont additionnées, le libellé les cite) ;
   le lot est figé (créancier, IBAN et montants) — le fichier se régénère à l'identique.
4. *Télécharger le fichier* (code `sdd-file:<id>`) → le remettre à la banque (espace en ligne de la banque) → **« Marquer comme envoyé à la banque »**.
5. Une fois la date passée et le relevé vérifié, **Clôturer le lot** (code `sdd-settle:<id>`) : on marque les prélèvements **rejetés** (motif
   obligatoire, option de révoquer le mandat) ; tous les autres sont enregistrés comme règlements (mode *prélèvement*, date = date de
   prélèvement). Tout ou rien. Une facture rejetée reste impayée et redevient prélevable. La clôture est refusée avant la date de prélèvement, et si un
   règlement a été enregistré à la main sur une facture depuis la préparation (annulez-le d'abord).
6. Un lot *préparé* ou *envoyé* peut être annulé, avec un motif (code `sdd-cancel:<id>`) ; un lot clôturé ne le peut plus.

**Règles appliquées**
- **FRST** pour le premier prélèvement d'un mandat, **RCUR** ensuite (un prélèvement rejeté ne compte pas comme premier passage) ;
- un seul lot « préparé » à la fois ; 500 prélèvements et 1 000 factures au plus par lot ; une facture déjà dans un lot préparé ou
  envoyé n'est plus proposée ;
- `MsgId` = `CEZ-SDD-AAAAMMJJHHMMSS-<n° de lot>` ; `EndToEndId` = numéro de la facture (si une seule) sinon `CEZ<lot>-<n>` ;
- les textes sont ramenés au jeu de caractères SEPA (`Œ` → `OE`, accents retirés…) ;
- **l'IBAN n'apparaît en clair que dans le fichier du lot et la copie PDF du mandat** ; partout ailleurs (liste, journal, réponses de l'API) :
  pays, clé et quatre derniers caractères ;
- chaque étape (mandat créé / révoqué, lot préparé / envoyé / clôturé / annulé, règlement) est écrite dans le journal chaîné.

**À savoir avant le premier vrai prélèvement**
- **Le fichier n'a pas pu être testé auprès d'une vraie banque** : il suit la norme EPC / ISO 20022 (pain.008.001.02) et passe tous les
  contrôles internes, mais faites un **premier lot de faible montant**, et demandez à votre banque la version de format qu'elle accepte
  et son horaire limite de remise ;
- **le préavis est votre responsabilité** : le module avertit si la date choisie tombe avant l'échéance de la facture ou moins de 14 jours (réglable)
  après sa date d'émission, mais ne l'impose pas. Le client doit avoir été prévenu du prélèvement et de son montant ;
- les **PDF de facture** affichent toujours le bloc de virement (IBAN) pour un hôtel prélevé ; la mention « Réglé par prélèvement SEPA »
  n'est pas ajoutée ;
- un **retour après clôture** (contestation jusqu'à 8 semaines en CORE, 13 mois si non autorisé) se traite en annulant le règlement sur la
  facture (écriture inverse) : elle redevient due ;
- un hôtel est prélevé **une fois par lot** (ses factures sont additionnées) ;
- les mandats et lots ne sont pas visibles par les hôtels dans leur espace client.

### PDF (factures, avoirs, devis, bons, annexes)

Tous les PDF du site partagent une même charte, définie dans `src/utils/pdfKit.js` :

| Document | Fichier | Particularités |
|---|---|---|
| Facture, avoir, devis, brouillon | `src/billing/pdf.js` | logo, adresse du client à l'emplacement de la fenêtre d'enveloppe (repères de pliage dans la marge), détail de la TVA, net à payer en grand, bloc de virement (IBAN, échéance, référence à rappeler), pastille « Payée », « Bon pour accord » sur les devis, filigrane sur les brouillons |
| Bon de livraison | `src/utils/pdf.js` | quantités commandées / livrées (astérisque si écart), notes, **zones de signature** « Remis par » / « Reçu par » |
| Bon de préparation | `src/utils/pdf.js` | une carte par chariot avec jauges de volume et de poids (rouge au-delà de 95 %), cases à cocher numérotées dans l'ordre de chargement, encadré d'alerte pour ce qui ne rentre pas, visas |
| Annexe de facture, récapitulatif | `src/utils/pdf.js` | détail BL par BL avec sous-totaux ; synthèse par article |
| Mandat de prélèvement SEPA | `src/billing/sddPdf.js` | modèle européen (textes CORE ou B2B), champs à compléter, zones de lieu/date et de signature |

- les polices (Inter et Instrument Serif, licence OFL) sont **dans le dépôt** (`src/assets/fonts`) : le rendu est identique partout ; sans elles, le PDF est produit avec Helvetica ;
- l'identité de la société (en-tête, pied de page de chaque page) vient de Facturation → Émetteur ; les factures émises gardent l'identité figée à l'émission ;
- les PDF sont lisibles en noir et blanc (aucune information portée par la seule couleur) ;
- **changer la mise en page ne change aucune facture émise** : l'empreinte d'intégrité porte sur les données figées, pas sur le fichier ; un PDF régénéré a le même contenu avec la mise en page du moment ;
- `npm run pdf:samples [dossier]` génère un exemplaire de chaque modèle avec des données fictives (base jetable) pour juger un changement de mise en page ; `test/pdf.test.js` vérifie que chaque modèle se génère avec le bon nombre de pages.

### Protection de l'espace administration

Le mot de passe administrateur ouvre toute la production ; il est maintenant protégé comme suit (`src/middleware/security.js`) :

- **essais limités** : 5 erreurs en 15 minutes → connexion bloquée 15 minutes pour cette adresse, durée doublée à chaque récidive
  (24 h au plus). Pendant le blocage, même le bon mot de passe est refusé. Le compteur est en mémoire : un redémarrage le remet à zéro.
  Un navigateur qui a déjà ouvert l'administration avec succès a **son propre compteur** : un inconnu qui rate 5 fois derrière la même
  adresse (relais d'hébergement) n'enferme donc pas le propriétaire dehors. Si le site est attaqué depuis beaucoup d'adresses à la fois
  (plus de 30 échecs en une heure), chaque échec est en plus ralenti de 1,5 s — jamais de blocage général ;
- **la session administrateur expire** : après **12 h sans activité** (`ADMIN_IDLE_MINUTES`) ou **7 jours** après la connexion
  (`ADMIN_MAX_HOURS`), alors qu'elle durait 30 jours sans condition. L'écran revient alors à la saisie du mot de passe avec un message.
  Se déconnecter referme aussi le déverrouillage de la Facturation ;
- **nouvel identifiant de session à chaque connexion** (une session préparée à l'avance par un tiers ne devient pas administratrice) ;
- **changer le mot de passe** : Réglages → « Sécurité » (ancien mot de passe exigé, 10 caractères minimum). Tous les **autres** appareils
  connectés sont déconnectés à leur prochaine action. La création initiale reste à 6 caractères minimum ;
- **requêtes venues d'un autre site refusées** : toute requête de modification vers `/api/admin` dont l'en-tête `Origin` n'est pas ce site est rejetée (403) ;
- **en-têtes de sécurité** : `X-Content-Type-Options`, `X-Frame-Options` / `frame-ancestors` (l'application ne s'affiche pas dans le cadre d'un autre site),
  `Referrer-Policy`, HSTS en HTTPS ; cookie de session « Secure » en HTTPS ; en-tête `X-Powered-By` retiré ;
- les échecs, blocages et changements de mot de passe sont écrits dans le journal du serveur (`[sécurité] …`).

À savoir : au premier déploiement, la session administrateur en cours est refusée une fois (elle n'a pas d'horodatage) : il faut se
reconnecter. **Mot de passe administrateur oublié** : pas de réinitialisation par l'écran (comme avant) ; elle se fait directement dans
la base, sur l'hébergeur. Le second facteur et les autres renforcements sont décrits
juste en dessous.

#### Renforcement supplémentaire

- **double authentification (facultative, recommandée)** : Réglages → « Sécurité » → Activer. Application d'authentification au choix
  (code à 6 chiffres, norme RFC 6238, aucune bibliothèque externe ni service tiers). Le mot de passe seul n'ouvre alors plus rien : la
  connexion se fait en deux étapes, un code ne sert **qu'une fois**, 8 **codes de secours** à usage unique sont donnés à l'activation (seule
  leur empreinte est conservée). Le secret est scellé (AES-256-GCM, clé dérivée de `SESSION_SECRET` : **ne changez pas `SESSION_SECRET`**
  sans désactiver d'abord la double authentification, sinon le secret devient illisible). Les codes faux comptent dans le blocage ;
  désactiver exige le mot de passe **et** un code de l'application ;
- **journal de sécurité** (Réglages → « Sécurité », 1 000 dernières lignes) : connexions, échecs, blocages, changements de mot de passe,
  double authentification, création et révocation des accès Claude. Jamais de mot de passe ni de code dedans ;
- **politique de contenu (CSP)** : sur les pages, seuls les scripts du site s'exécutent (aucun script en ligne, aucun gestionnaire
  `onclick=` en ligne ; jsPDF est servi par le site dans `public/vendor/`, plus par un CDN). Même si un texte saisi par un invité
  contenait du code, le navigateur ne l'exécuterait pas. Les contenus saisis par des tiers (nom d'hôtel, adresse, notes…) sont de plus
  échappés à l'affichage dans l'administration. `style-src` autorise encore les styles en ligne (de nombreux attributs `style=`) ;
- **codes d'accès des hôtels** : 6 à 10 chiffres, sans suite (123456) ni répétition (111111, 121212). Les codes déjà choisis restent
  valables jusqu'à leur changement. Essais limités par e-mail (5 erreurs → 15 min, durée doublée à chaque récidive, 24 h au plus).
  `CLIENT_CODE_POLICY=legacy` rétablit l'ancienne règle (tests seulement) ;
- **API publique** : cadences par adresse (création de compte 20 / h, commande d'invité 30 / h, hôtel connecté 120 / h, suivi de commande
  60 / 15 min, connexion hôtel 120 / 15 min) ; champs bornés (société 120 caractères, adresse 250, notes 2 000, 150 lignes, quantité
  100 000) ; le suivi par numéro de ticket (`/api/orders/track/<ticket>`) ne renvoie, sans connexion, **que** le statut et les dates — les
  tickets se suivent et s'énuméreraient ; le détail est réservé à l'hôtel concerné et à l'administration ; nouvel identifiant de
  session à la connexion d'un hôtel ;
- **webhooks des hôtels** : adresse `localhost`, réseau privé, `.internal`, `.local`, métadonnées du cloud (169.254.x.x) ou IPv6 locale
  refusées ; le nom est résolu au moment de l'envoi et l'adresse obtenue contrôlée ; redirections non suivies (sinon le serveur pourrait être
  poussé à appeler sa propre machine) ;
- dépendances : `nodemailer` mis à jour (vulnérabilité élevée corrigée).

À savoir : derrière l'hébergeur, le serveur doit compter le bon nombre de relais (`TRUST_PROXY` : 2 par défaut sur Render, 1 ailleurs).
Réglages → « Sécurité » affiche l'adresse que le serveur voit : elle doit être **la vôtre**, pas celle d'un relais (Cloudflare) ; sinon,
ajustez `TRUST_PROXY`.
Les jetons d'API des hôtels (`/api/v1`) sont encore stockés en clair : à passer en empreinte dans une prochaine étape.

### Accès Claude (lecture seule)

Pour que Claude puisse **consulter** les données (jamais les modifier) : Facturation → Sécurité et sauvegardes → « Accès Claude ».
Créer un accès demande le code de la Facturation ; le jeton `czc_…` n'est montré **qu'une fois**, avec un message prêt à coller à Claude.

- **périmètres au choix** : *exploitation* (commandes sans prix ni téléphone, statistiques d'activité), *hôtels* (coordonnées, adresse, SIRET),
  *finance* (factures, avoirs, encaissements, ventes jour par jour). Un accès ne voit que ce qui a été coché ;
- **jamais accessibles** avec ce jeton : administration, mots de passe et codes d'accès des hôtels, webhooks et clés techniques, IBAN et mandats,
  réglages, sauvegardes, PDF ; **aucune écriture** : l'API `/api/claude/v1` n'accepte que `GET` (tout autre verbe : 405) ;
- **durée limitée** : 1 à 30 jours (7 par défaut), 10 accès actifs au plus, 60 lectures par minute et par jeton ;
- **révocation immédiate** (un accès, ou « Tout révoquer ») et **coupure d'urgence** : variable `CLAUDE_ACCESS=off` sur l'hébergeur ;
- **journal** : chaque lecture est inscrite (date, accès, chemin, résultat, adresse) ; seule l'empreinte sha256 du jeton est en base ;
  le jeton ne passe jamais dans l'adresse, seulement dans l'en-tête `Authorization: Bearer …` ;
- 20 faux jetons en 15 minutes depuis une adresse ferment la route 15 minutes.

La liste des routes se lit avec `GET /api/claude/v1` (jeton en en-tête). Une session Claude hébergée n'atteint le site que si le domaine y est
autorisé dans les réglages du compte Claude (accès réseau) : sinon, utiliser une session qui a accès à internet.

### Verrou de la Facturation

La session administrateur ouvre tout le logiciel et dure des jours ; la facturation
émet des documents légaux irréversibles et affiche l'IBAN. Elle est donc protégée par
un **second code, distinct du mot de passe administrateur**, défini à la première ouverture.

- redemandé après **10 minutes d'inactivité** (`BILLING_IDLE_MINUTES`, minimum 1) ;
- **ressaisie du code** avant chaque acte sensible : émission d'une facture ou d'un avoir,
  création d'un avoir, émission groupée du mois, export FEC, modification des coordonnées de
  l'émetteur (dont l'IBAN), téléchargement d'une sauvegarde, activation de l'envoi automatique
  Pennylane, **suppression d'un article ou d'un hôtel**, **nouveau code d'accès d'un hôtel**, **régénération d'un secret de webhook**,
  **application d'une opération en masse sur les tarifs**, **recalcul des BL non facturés**, **tout import CSV** (articles, hôtels, tarifs),
  **règlement en lot**, **rattachement de BL à un hôtel**, et tout le circuit **SEPA** (réglages créancier, création / révocation d'un mandat,
  copie PDF d'un mandat, préparation, téléchargement du fichier, clôture et annulation d'un lot).
  L'autorisation est à usage unique, liée à l'acte précis (ex. `issue:42`, `prices-bulk:7`) et valable 90 s ;
- 5 erreurs de code → blocage 15 minutes, conservé en base (survit à un redémarrage) ;
- **code oublié** : sur l'hébergeur, définir `BILLING_LOCK_RESET=<valeur quelconque>` puis
  redémarrer ; le code est effacé (une seule fois par valeur distincte) et un nouveau est demandé.
  Les données ne sont pas touchées. Changer la valeur à chaque nouvelle réinitialisation.

### Sauvegardes automatiques

Chaque nuit (après 3 h, heure de Paris ; rattrapage au démarrage si la dernière a plus de 26 h) :
instantané cohérent de la base → contrôle d'intégrité SQLite → purge des sessions →
compression → **chiffrement AES-256-GCM** → copie locale (30 conservées, `BACKUP_KEEP_LOCAL`)
puis copies **hors serveur**. Une copie sur le disque du serveur ne protège pas de la perte du
serveur : configurez au moins une destination hors serveur.

| Variable | Rôle |
|---|---|
| `BACKUP_PASSPHRASE` | phrase secrète de chiffrement. **Sans elle, rien ne part hors serveur.** À conserver ailleurs : sans elle une sauvegarde est illisible |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_S3_PREFIX` | stockage compatible S3 (Backblaze B2, Cloudflare R2, Scaleway…) |
| `BACKUP_EMAIL_TO`, `BACKUP_EMAIL_MAX_MB` | copie par e-mail (nécessite SMTP) |
| `BACKUP_ALERT_TO` | alerte e-mail si une sauvegarde échoue (une par jour au plus) |
| `BACKUP_SCHEDULER=off` | désactive la planification (tests) |

La page Sécurité et sauvegardes affiche l'état (ok / à vérifier / critique au-delà de 48 h sans copie
hors serveur), l'historique, et permet de sauvegarder immédiatement ou de télécharger une copie.
La rétention côté S3 n'est pas purgée par l'application : utilisez une règle de cycle de vie du bucket.

#### Copie chaque soir sur l'ordinateur de l'utilisateur

Le serveur (Render) ne peut pas écrire sur un ordinateur : c'est l'ordinateur qui **vient chercher** la copie.
Facturation → Sécurité et sauvegardes → *Copie chaque soir sur mon ordinateur* → **Préparer le programme** (code de la
Facturation demandé) télécharge `sauvegarde-cezanne.ps1`, propre à cette installation. Sur le PC (Windows) : clic droit →
*Exécuter avec PowerShell*. Le programme :

- s'installe (copie dans `%LOCALAPPDATA%\BlanchisserieCezanne`, tâche planifiée « Sauvegarde Blanchisserie Cezanne », **chaque jour à 22 h**,
  rattrapée au rallumage si le PC était éteint) puis fait une première copie ;
- demande au serveur une sauvegarde **fraîche** (`GET /api/backup-pull/latest?fresh=1`), vérifie l'empreinte SHA-256 reçue,
  la range dans `Documents\Sauvegardes Cezanne` (90 dernières conservées) et tient un `journal.txt`.

Sécurité : jeton dédié (`cz-` + 256 bits aléatoires) dont seule l'**empreinte** est stockée ; il n'ouvre que cette route (jamais
l'administration) ; un nouveau programme remplace et révoque l'ancien jeton, « Arrêter cette copie » le révoque ; au-delà de 20 faux jetons
en 15 minutes la route se ferme 15 minutes. **Sans `BACKUP_PASSPHRASE`, la route refuse** (aucune base en clair ne quitte le serveur) : les
copies reçues sont chiffrées comme les autres (`scripts/restore-backup.js` pour les lire). Une copie envoyée à l'ordinateur compte comme
copie hors serveur (l'état passe au vert, l'historique affiche « Ordinateur (soir) » ; sans nouvelle copie depuis 36 h, un avertissement apparaît).

Mac ou Linux : même principe avec `curl` (à planifier avec `launchd` ou `cron` ; le jeton se récupère en ouvrant le `.ps1` dans un éditeur de texte) :

```bash
curl -fsS -D h.txt -H "Authorization: Bearer cz-…" -o copie.enc "https://votre-site/api/backup-pull/latest?fresh=1"
# l'empreinte à comparer est dans l'en-tête X-Backup-Sha256, le nom du fichier dans X-Backup-Name
```

Le programme Windows n'a pas pu être exécuté sur un vrai Windows pendant le développement (serveur, jeton, empreinte et écran sont testés
automatiquement) : à valider une fois sur le PC (lancer le programme, vérifier le dossier, puis `journal.txt`).

**Restauration** (arrêter le serveur d'abord) :

```bash
BACKUP_PASSPHRASE='votre phrase secrète' node scripts/restore-backup.js \
  cezanne-AAAAMMJJTHHMMSSZ.sqlite.gz.enc restauree.sqlite
# garder une copie de DATA_DIR/database.sqlite, la remplacer par restauree.sqlite, redémarrer,
# puis lancer Facturation → Contrôle et FEC → Lancer le contrôle.
```

### Envoi à Pennylane (optionnel)

Le logiciel reste la source de vérité pour **émettre** ; Pennylane reçoit une copie pour la
comptabilité et le rapprochement bancaire.

- `PENNYLANE_API_TOKEN` : jeton d'API, **uniquement en variable d'environnement** (jamais dans le code) ;
  `PENNYLANE_BASE_URL` pour changer d'URL ; `PENNYLANE_SCHEDULER=off` pour désactiver la file.
- Page Pennylane : tester la connexion, envoi manuel d'un document ou de tous les non transmis,
  réessai des échecs, **envoi automatique** (seuls les documents émis après l'activation).
- Factures et avoirs sont transmis avec leur PDF, les lignes regroupées par taux de TVA ; les avoirs
  en montants négatifs ; nouvel essai automatique (5 au plus) en cas d'échec.
- **Les champs exacts de l'API Pennylane n'ont pas pu être vérifiés sur un compte réel** : testez d'abord
  sur un compte d'essai avant d'activer l'envoi automatique.

### E-mails

`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (voir plus haut) servent aussi à l'envoi des factures, devis et
relances depuis le serveur. Sans SMTP, l'envoi depuis le serveur répond « non configuré » (503) ; une relance faite par
téléphone peut quand même être notée.

### Envoi par Outlook (message prêt, PDF joint)

« Envoyer par e-mail » (facture, avoir, devis, relance, **bon de livraison**) prépare **un message Outlook déjà prêt :
destinataire, objet, texte et PDF en pièce jointe**. Rien ne part tant que vous n'avez pas cliqué sur Envoyer dans Outlook.
Deux modes, au choix dans la fenêtre d'envoi ou dans Facturation → Outlook (choix mémorisé dans le navigateur ; clé
`cz-outlook-mode2`, donc un ancien choix ne retient pas l'ouverture) :

- **Outlook en ligne** (**par défaut** : à chaque clic, un **nouvel onglet** du navigateur s'ouvre sur Outlook) : brouillon créé
  dans la boîte par Microsoft Graph, PDF déjà joint (détail ci-dessous), ou, tant qu'Outlook n'est pas connecté, message
  prérempli dans Outlook Web + PDF téléchargé à joindre. L'onglet est ouvert dans le clic même (sinon le navigateur le bloque).
- **Outlook installé sur cet ordinateur** (à choisir expressément ; **rien à configurer**, aucun compte Microsoft à relier) : le
  serveur fabrique un fichier message `.eml` (brouillon non envoyé, en-tête `X-Unsent: 1`, PDF en pièce jointe, sans expéditeur
  imposé : Outlook met le compte de la personne). Le navigateur le télécharge ; un clic dessus l'ouvre dans Outlook. Un site web
  ne peut ni lancer Outlook ni joindre un fichier par un lien `mailto:`, d'où ce fichier. Astuce : dans Chrome/Edge, flèche à
  côté du fichier → « Toujours ouvrir les fichiers de ce type » ; si Windows ouvre une autre application, clic droit sur un
  `.eml` → Ouvrir avec → Outlook → « Toujours utiliser ». Historique : `outlook-file`. **Non vérifié avec votre version
  d'Outlook** (la version classique ouvre un `.eml` « X-Unsent » en fenêtre de rédaction ; le nouvel Outlook peut se comporter
  autrement).

**Bons de livraison** : deux endroits, même mécanique (brouillon Outlook avec le PDF du bon). Fiche d'un BL (Facturation → Bons
de livraison → « Envoyer par e-mail ») : fenêtre d'envoi habituelle, destinataire = e-mail de l'hôtel
(`GET /deliveries/:id/mail-preview`, `POST /deliveries/:id/send`, réservé aux BL livrés). Fenêtre d'une commande
(administration) : « Envoyer par e-mail (Outlook) », destinataire = e-mail des réglages (facultatif),
`POST /api/admin/orders/:id/delivery-note` avec `channel` (`outlook` ou `outlook-file`) ; le PDF du bon peut aussi se
télécharger (`GET /api/admin/orders/:id/delivery-note.pdf`) quand Outlook ne peut pas le joindre. Les bons n'ont **pas
d'historique d'envoi** (le journal des e-mails ne concerne que factures, avoirs, devis et relances). L'ancien envoi direct par
SMTP de la fenêtre d'une commande reste côté serveur (appel sans `channel`) mais l'écran passe désormais par Outlook.

Pour le mode en ligne, le brouillon est créé dans votre boîte par Microsoft Graph. Une fois, il faut déclarer l'application chez Microsoft :

1. portal.azure.com → Microsoft Entra ID → Inscriptions d'applications → Nouvelle inscription (comptes professionnels
   et personnels) ;
2. type de redirection **Web**, adresse affichée sur Facturation → Outlook (`<adresse du site>/api/admin/billing/outlook/callback`) ;
3. Autorisations API → Microsoft Graph → déléguées : `Mail.ReadWrite`, `User.Read`, `offline_access` (**pas** `Mail.Send`) ;
4. Certificats et secrets → nouveau secret client → copier sa **valeur** ;
5. variables d'environnement Render : `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (et `MS_TENANT` si l'application est limitée à
   votre organisation ; défaut `common`), plus `PUBLIC_URL` si `RENDER_EXTERNAL_URL` n'est pas défini ; redéployer ;
6. Facturation → Outlook → « Connecter mon Outlook » (code de la Facturation demandé), puis accepter chez Microsoft.

Sécurité : l'application ne peut que créer et modifier des brouillons (aucune permission d'envoi) ; le jeton de
renouvellement est chiffré (AES-256-GCM, clé dérivée de `SESSION_SECRET` : changer ce secret impose de reconnecter) ;
connexion et déconnexion exigent le code de la Facturation ; l'historique garde la trace (`outlook-draft`).
Pièces jointes limitées à 3 Mo.

Repli : si Outlook n'est pas connecté (ou si Microsoft refuse), le bouton ouvre le brouillon Outlook Web sans pièce jointe et
télécharge le PDF à glisser dedans ; l'envoi est alors noté comme « préparé dans Outlook » (`outlook`).
**Non vérifié sur un vrai compte Microsoft** (tests avec un faux serveur Microsoft) : à essayer une première fois avec une
facture de test.

### Quantités négatives (reprises de linge)

Une **quantité négative** se saisit à deux endroits, **réservés à l'administrateur** (session administrateur ; la Facturation exige en plus son code) :

- **Commande** (« Nouvelle commande », « + Ajouter un article », quantités livrées) : la ligne devient une *reprise* (ex. −20 taies).
  Zéro reste refusé. La quantité livrée d'une reprise reste négative ou nulle. Les reprises ne comptent pas dans la file
  Production ni dans « quantités à préparer » ; elles apparaissent sur la commande, le BL (PDF) et la facture. Les commandes
  passées par l'hôtel (espace client, invité compris), l'API, les e-mails entrants et le planning des chambres restent strictement
  positives (contrôle `src/utils/orderQty.js` en plus de la validation de chaque route, la base n'interdisant plus le négatif ;
  « Recommander » ignore les reprises).
- **Facture** (éditeur de lignes, facture libre, ou issue de BL) : la ligne se déduit du total ; le prix reste positif. Depuis
  des BL : détail et regroupé reprennent la quantité négative ; « par BL » donne une ligne de quantité −1 si le solde d'un BL est
  négatif. Les arrondis sont symétriques (−2,5 c → −3 c, comme +2,5 → +3) ; la TVA se calcule par taux, une base négative pour
  un taux donne une TVA négative. Une facture au **total négatif** se garde en brouillon mais **ne s'émet pas** (message :
  émettre un avoir). L'avoir crédite une ligne négative avec une quantité négative (même sens, jamais plus que la ligne) :
  l'avoir total vaut exactement la facture. Dans le FEC, un montant négatif (ex. TVA d'un taux ne contenant que des reprises)
  passe du côté opposé du journal : jamais de signe moins.

Migration : la table `order_items` portait `CHECK (qty > 0)`. Au démarrage, une base existante est recréée avec `CHECK (qty <> 0)`
(copie intégrale, clés étrangères contrôlées, index refaits ; annulée proprement si un contrôle échoue) ; sans effet ensuite.

### Tests

`npm test` (367 tests ; bases SQLite jetables, serveurs HTTP factices pour S3, Pennylane et Microsoft, faux serveur SMTP, aucun effet sur vos données).

### Limites connues — à traiter avant d'utiliser en production

- **Articles, tarifs et fiches hôtels exigent désormais le code de la Facturation** : un opérateur qui n'a que le mot de passe
  administrateur ne peut plus les modifier (il saisit toujours les commandes, voit la liste des hôtels et peut en créer un en
  « Nouvelle commande »). C'est voulu, à connaître avant de former l'équipe.
- **Prélèvements SEPA : fichier non testé auprès d'une banque réelle** (voir « À savoir avant le premier vrai prélèvement » ci-dessus).
- Un hôtel qui a des factures, avoirs ou devis ne peut pas être supprimé, un article utilisé par une règle de linge non plus.
- L'ancien écran d'administration « Facture » (circuit Odoo) n'est plus relié à aucun bouton ; son code est conservé, inactif.

- **Pas de transmission à une plateforme agréée (PA)** : l'obligation d'émission
  électronique pour les PME démarre au 1er septembre 2027 (à vérifier, le calendrier
  a déjà bougé). Il faudra choisir une PA et brancher son API ; le champ
  `pa_status` est déjà prévu sur chaque facture. Pas de Factur-X/UBL non plus.
  L'envoi à Pennylane n'est **pas** une transmission via plateforme agréée.
- **Certification NF525 / attestation éditeur** : non fournie. Le moteur applique
  les principes (inaltérabilité, chaînage, traçabilité) mais n'est pas certifié.
- **Numéros de comptes du FEC** (411, 706000, 445710, 512000) : usuels, à valider
  avec votre expert-comptable (constantes dans `src/billing/fec.js`).
- Les PDF des factures créées à l'époque d'Odoo (`DATA_DIR/invoices`) ne sont **pas** incluses
  dans les sauvegardes (la base, elle, l'est entièrement).
