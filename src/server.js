require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteSessionStore = require('better-sqlite3-session-store')(session);
const db = require('./db');
const security = require('./middleware/security');

const { getServicesForClient, CATEGORIES } = require('./services');
const clientsRouter = require('./routes/clients');
const ordersRouter = require('./routes/orders');
const adminRouter = require('./routes/admin');
const webhooksRouter = require('./routes/webhooks');
const roomTypesRouter = require('./routes/roomTypes');
const productionRouter = require('./routes/production');
const rhRouter = require('./routes/rh');
const badgeuseRouter = require('./routes/badgeuse');
const prodRouter = require('./routes/prod');
const atelierRouter = require('./routes/atelier');
const logisticsRouter = require('./routes/logistics');
const statsRouter = require('./routes/stats');
const articlesRouter = require('./routes/articles');
const driverPortalRouter = require('./routes/driverPortal');
const garageRouter = require('./routes/garage');
const apiV1Router = require('./routes/apiV1');
const backupPullRouter = require('./routes/backupPull');
const claudeApiRouter = require('./routes/claudeApi');
const billingRouter = require('./routes/billing');
const { startInvoiceStatusScheduler } = require('./utils/invoiceStatusSync');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.warn(
    '⚠️  SESSION_SECRET absent du .env — une valeur temporaire est utilisée, ' +
    'les sessions seront invalidées à chaque redémarrage. Copiez .env.example en .env et renseignez-le.'
  );
}

// Derrière les relais de l'hébergeur : adresse réelle du visiteur (limites d'essais et de cadence, journal) et connexion sécurisée
// (cookie « Secure »). Sur Render, mesuré en production : DEUX relais (Cloudflare puis Render) — avec un seul, le serveur prenait
// l'adresse de Cloudflare pour celle du visiteur, partagée par tous ceux qui passent par le même point d'entrée.
// TRUST_PROXY=0 pour un lancement sans relais, ou le nombre de relais si l'hébergement en place un autre nombre.
const DEFAULT_RELAYS = process.env.RENDER ? 2 : 1;
app.set('trust proxy', process.env.TRUST_PROXY === undefined ? DEFAULT_RELAYS : (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY)));
app.disable('x-powered-by');
app.use(security.securityHeaders);
app.use(express.json());
app.use('/api/admin', security.sameOriginOnly);
app.use(session({
  name: 'cezanne.sid',
  // Store SQLite persistant — SANS ça, express-session utilise par
  // défaut un stockage en mémoire (MemoryStore), explicitement déconseillé
  // en production : chaque redémarrage du processus Node (donc chaque
  // déploiement) effaçait TOUTES les sessions, déconnectant admin et
  // hôtels connectés sans prévenir. Réutilise la connexion base de
  // données déjà existante (db.js) plutôt que d'en ouvrir une séparée.
  store: new SqliteSessionStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }, // purge les sessions expirées toutes les 15 min
  }),
  secret: process.env.SESSION_SECRET || 'dev-secret-non-persistant',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',   // « Secure » dès que la connexion est en https
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 jours
  },
}));

// Les réponses d'API ne doivent jamais être mises en cache (par le
// navigateur ou un intermédiaire) : ce sont des données qui changent
// constamment (catalogue, commandes...), et un cache silencieux donnerait
// l'impression qu'une modification pourtant bien enregistrée n'a aucun
// effet à l'affichage.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Catalogue filtré selon le client connecté : s'il a des articles qui lui
// sont spécifiquement attribués (Administration → Gestion des articles),
// seuls ceux-là sont renvoyés. Sinon (invité, ou hôtel sans attribution
// particulière), le catalogue complet, comme avant.
app.get('/api/services', (req, res) => {
  const services = getServicesForClient(req.session.clientId || null);
  res.json({ services, categories: CATEGORIES });
});

app.use('/api/clients', clientsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/admin/room-types', roomTypesRouter);
app.use('/api/admin/production', productionRouter);
app.use('/api/admin/rh', rhRouter);
app.use('/api/badgeuse', badgeuseRouter);
app.use('/api/admin/atelier', prodRouter);
app.use('/api/atelier', atelierRouter);
app.use('/api/admin/logistics', logisticsRouter);
app.use('/api/admin/stats', statsRouter);
app.use('/api/admin/articles', articlesRouter);
app.use('/api/driver-portal', driverPortalRouter);
app.use('/api/admin/garage', garageRouter);
app.use('/api/admin/billing', billingRouter);
app.use('/api/v1', apiV1Router);
app.use('/api/backup-pull', backupPullRouter);
app.use('/api/claude/v1', claudeApiRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Page de la tablette de pointage (l'adresse d'activation porte le jeton après le « # », qui ne part jamais vers le serveur).
app.get('/badgeuse', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'badgeuse.html'));
});

// Écran de la tablette de l'atelier (machines, lots) : même activation par jeton que la badgeuse.
app.get('/atelier', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '..', 'public', 'atelier.html'));
});

// Toute route non-API renvoie l'app (single page)
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err && (err.status === 413 || err.type === 'entity.too.large')) return res.status(413).json({ error: 'Fichier trop volumineux (8 Mo au plus).' });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

app.listen(PORT, () => {
  console.log(`Blanchisserie Cézanne — serveur lancé sur http://localhost:${PORT}`);
  startInvoiceStatusScheduler();
  require('./backup').startScheduler();
  require('./billing/pennylane').startScheduler();
});
