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
- **orders** — une ligne par commande (ticket, client associé ou invité, statut, dates, notes).
- **order_items** — les articles d'une commande (catégorie de linge, quantité), liés à `orders` par `order_id`.
- **admin** — une seule ligne (mot de passe haché + email de réception des bons de livraison).
- **order_seq** — compteur utilisé pour générer les numéros de ticket (`CZ-AAMMJJ-XXXX`).

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
- **Statistiques** — vue d'ensemble : commandes totales, articles traités,
  activité des 30 derniers jours, répartition par statut, top hôtels et
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
- si vous êtes derrière un reverse proxy, ajouter `app.set('trust proxy', 1)`
  ainsi que `cookie: { secure: true }` dans `src/server.js` pour que les
  cookies de session fonctionnent correctement en HTTPS.

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
un SIREN/SIRET valide (obligatoire sur les factures B2B depuis le 1er sept. 2026).

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
- le prix est **figé sur la commande à sa création**. Modifier un prix ne change jamais les commandes passées ;
  pour corriger celles qui ne sont ni facturées ni dans un brouillon, l'action explicite
  « Réappliquer aux BL non facturés » (fiche de l'hôtel) les recalcule au tarif en vigueur à leur date ;
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

### Bons de livraison

Page **Facturation → Bons de livraison** (juste sous « Factures »). Un bon de livraison (BL) est une commande au
statut « Livrée » ; sa date est la date de livraison prévue, à défaut la date de création (la même qui sert à facturer
et à choisir le tarif en vigueur).

- **Filtres** : période (du / au, bornes incluses, avec « Ce mois-ci », « Mois dernier », « 30 derniers jours »),
  hôtel, recherche (numéro de bon, nom d'hôtel) et état de facturation. Les onglets *À facturer / Dans un brouillon /
  Facturés* affichent leur nombre ; le total HT de la sélection s'affiche au-dessus du tableau ;
- **État de facturation**, calculé comme « Facturer le mois » : *à facturer*, *dans un brouillon*, *facturé* (avec le numéro
  de facture), *facturé (ancien circuit)* pour l'historique Odoo. Une facture annulée par un avoir total remet le BL à facturer ;
- **Montants** : quantité livrée × prix figé sur la commande. Un bon dont la quantité livrée diffère de la commande est signalé ;
- **Exports** : PDF d'un bon, **PDF groupé** de tous les bons filtrés (un bon par page, du plus ancien au plus récent,
  500 bons au plus) et CSV Excel (`;`, virgule décimale, BOM) ;
- depuis la fiche d'un hôtel, « Voir ses bons de livraison » ouvre la page déjà filtrée.

La page ne fait que lire : elle ne modifie ni commande ni facture. Elle est derrière le code de la Facturation.

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

Onglet **Statistiques** de l'administration : période rapide (7 / 30 jours, mois, 90 jours) ou dates libres, tuiles de synthèse,
graphique jour par jour (au choix du chiffre affiché), tableau jour par jour avec détail dépliable (commandes reçues et livrées,
valeur, factures, règlements) et export Excel (CSV).

- **Exploitation** (commandes, pièces, poids, kilomètres, écarts commandé/livré) : `GET /api/admin/stats/daily`. Les commandes sont
  datées à l'heure de Paris à la réception, à la date du BL à la livraison.
- **Montants** (livré valorisé, facturé, avoirs, encaissé par mode de règlement, reste dû) : derrière le **verrou de la Facturation**.
  Sans le code, aucun montant n'est affiché ni envoyé par le serveur (`GET /api/admin/billing/stats/daily[/:date]`).
- Une annulation de règlement se voit dans la journée où elle est écrite.

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
relances. Sans SMTP, l'envoi répond « non configuré » (503) ; une relance faite par téléphone peut quand même être notée.

### Tests

`npm test` (145 tests ; bases SQLite jetables, serveurs HTTP factices pour S3 et Pennylane, aucun effet sur vos données).

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
