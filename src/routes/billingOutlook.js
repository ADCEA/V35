// Connexion d'Outlook (Microsoft Graph) pour créer des brouillons avec le PDF joint — /api/admin/billing/outlook/*
const express = require('express');
const outlook = require('../billing/outlook');
const lock = require('../billing/lock');
const { wrap } = require('../billing/http');

const router = express.Router();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// État de la connexion (jamais de jeton).
router.get('/outlook/status', wrap((req, res) => { res.json(outlook.status()); }));

// Lance la connexion : renvoie l'adresse Microsoft où autoriser l'accès. Ressaisie du code de la Facturation exigée.
router.post('/outlook/connect', lock.requireStepUp('outlook-connect'), wrap((req, res) => {
  res.json({ url: outlook.authorizeUrl(req.session) });
}));

router.post('/outlook/disconnect', lock.requireStepUp('outlook-disconnect'), wrap((req, res) => {
  outlook.disconnect();
  res.json({ ok: true });
}));

// Retour de Microsoft (page affichée dans le navigateur, pas du JSON).
async function callback(req, res) {
  const page = (ok, title, text) => {
    res.status(ok ? 200 : 400).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f4f7fb;color:#16324f;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #dbe4ee;border-radius:10px;padding:28px 32px;max-width:460px;margin:16px}h1{font-size:20px;margin:0 0 10px}p{line-height:1.5;margin:0 0 18px}
a{display:inline-block;background:#1e90ff;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="/">Retourner au logiciel</a></main></body></html>`);
  };
  try {
    const who = await outlook.complete(req.session, req.query || {});
    page(true, 'Outlook est connecté', `${who.name ? `${who.name} — ` : ''}${who.email || 'compte Microsoft'}. Les brouillons seront créés dans cette boîte, avec la facture en pièce jointe. Rien ne part sans que vous cliquiez sur Envoyer dans Outlook.`);
  } catch (e) {
    if (!e || !e.status) console.error('[outlook]', e);
    page(false, 'Connexion à Outlook impossible', e && e.status ? e.message : 'Erreur inattendue : réessayez depuis Configuration → Outlook.');
  }
}

module.exports = { router, callback };
