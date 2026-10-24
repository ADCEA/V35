// Verrou de la Facturation : code distinct, essais limités, ressaisie à usage unique.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const path = require('path'); const fs = require('fs');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const B = '/api/admin/billing';
const CODE = 'bonne-phrase-42';

test('verrou : mise en place, essais limités, ressaisie à usage unique, oubli du code', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-lock-'));
  let s = await startServer({ dataDir });
  t.after(() => s.stop());
  const { call } = s;

  await call('POST', '/api/admin/setup', { password: 'secret123' });

  // Pas de code défini : tout est fermé sauf /lock/*
  let r = await call('GET', `${B}/lock/status`);
  assert.deepEqual([r.data.configured, r.data.unlocked], [false, false]);
  r = await call('GET', `${B}/settings`);
  assert.equal(r.status, 423); assert.equal(r.data.code, 'LOCK_SETUP_REQUIRED');

  // Mise en place : confirmation identique, code assez long et pas trivial
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: 'autre-chose' })).status, 400);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: '123', confirm: '123' })).status, 400);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: 'aaaaaaaa', confirm: 'aaaaaaaa' })).status, 400);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: 'autre-code-9', confirm: 'autre-code-9' })).status, 409, 'le code existant ne s\'écrase pas');
  assert.equal((await call('GET', `${B}/settings`)).status, 200, 'déverrouillé après la mise en place');

  // Le code n'est jamais stocké en clair
  const raw = new Database(path.join(dataDir, 'database.sqlite'));
  const h = raw.prepare('SELECT code_hash FROM billing_lock').get().code_hash;
  assert.ok(h.startsWith('$2') && !h.includes(CODE));

  // Verrouillage manuel
  await call('POST', `${B}/lock/lock`);
  assert.equal((await call('GET', `${B}/invoices`)).status, 423);
  assert.equal((await call('GET', `${B}/export/fec?year=2026`)).status, 423, 'même l\'export est fermé');

  // Mauvais code : compteur d'essais
  r = await call('POST', `${B}/lock/unlock`, { code: 'faux-code-1' });
  assert.equal(r.status, 401); assert.equal(r.data.attemptsLeft, 4);
  r = await call('POST', `${B}/lock/unlock`, { code: CODE });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', `${B}/invoices`)).status, 200);

  // Sans ressaisie, les actes sensibles sont refusés
  r = await call('PUT', `${B}/settings`, { iban: 'FR76 0000' });
  assert.equal(r.status, 403); assert.equal(r.data.code, 'STEP_UP_REQUIRED');
  assert.equal((await call('GET', `${B}/export/fec?year=2026`)).status, 403);
  assert.equal((await call('POST', `${B}/invoices/1/issue`, {})).status, 403);
  assert.equal((await call('POST', `${B}/invoices/1/credit-note`, { reason: 'x', full: true })).status, 403);

  // Mauvais code à la ressaisie → pas de feu vert
  r = await call('POST', `${B}/lock/confirm`, { code: 'faux', scope: 'settings' });
  assert.equal(r.status, 401);
  assert.equal((await call('PUT', `${B}/settings`, { iban: 'x' })).status, 403);

  // Feu vert à usage unique
  assert.equal((await call('POST', `${B}/lock/confirm`, { code: CODE, scope: 'settings' })).status, 200);
  assert.equal((await call('PUT', `${B}/settings`, { iban: 'FR76 3000 1007 9412 3456 7890 185' })).status, 200);
  assert.equal((await call('PUT', `${B}/settings`, { iban: 'FR76 0000' })).status, 403, 'une seule utilisation');

  // Feu vert lié à l'acte : issue:1 ne permet pas d'émettre la 2
  assert.equal((await call('POST', `${B}/lock/confirm`, { code: CODE, scope: 'issue:1' })).status, 200);
  assert.equal((await call('POST', `${B}/invoices/2/issue`, {})).status, 403);
  // (l'émission de la 1 passe l'étape de ressaisie ; la facture n'existe pas → 404 et non 403)
  assert.equal((await call('POST', `${B}/invoices/1/issue`, {})).status, 404);
  // Portée invalide refusée
  assert.equal((await call('POST', `${B}/lock/confirm`, { code: CODE, scope: 'x y;z' })).status, 400);

  // Changer le code exige l'ancien
  r = await call('POST', `${B}/lock/change`, { code: 'faux', newCode: 'nouveau-code-7', confirm: 'nouveau-code-7' });
  assert.equal(r.status, 401);
  r = await call('POST', `${B}/lock/change`, { code: CODE, newCode: 'nouveau-code-7', confirm: 'nouveau-code-7' });
  assert.equal(r.status, 200);
  await call('POST', `${B}/lock/lock`);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 401, 'l\'ancien code ne marche plus');
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: 'nouveau-code-7' })).status, 200);

  // Force brute : 5 échecs → blocage 15 min, même avec le bon code
  await call('POST', `${B}/lock/lock`);
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', `${B}/lock/unlock`, { code: 'zzz-faux-' + i })).status, 401);
  r = await call('POST', `${B}/lock/unlock`, { code: 'zzz-faux-5' });
  assert.equal(r.status, 429); assert.ok(r.data.retryAfterSec > 800);
  r = await call('POST', `${B}/lock/unlock`, { code: 'nouveau-code-7' });
  assert.equal(r.status, 429, 'bon code refusé pendant le blocage');
  r = await call('GET', `${B}/lock/status`);
  assert.ok(r.data.retryAfterSec > 0);

  // Le blocage survit à un redémarrage du serveur
  await s.stop();
  s = await startServer({ dataDir });
  await s.call('POST', '/api/admin/login', { password: 'secret123' });
  r = await s.call('POST', `${B}/lock/unlock`, { code: 'nouveau-code-7' });
  assert.equal(r.status, 429);

  // Les tentatives sont tracées dans le journal chaîné (sans jamais le code)
  const events = raw.prepare("SELECT action, detail_json FROM billing_events WHERE action LIKE 'billing_lock%' OR action LIKE 'step_up%' OR action = 'billing_unlocked'").all();
  assert.ok(events.some(e => e.action === 'billing_lock_lockout'));
  assert.ok(events.some(e => e.action === 'step_up_granted'));
  assert.ok(!JSON.stringify(events).includes('nouveau-code-7') && !JSON.stringify(events).includes(CODE));

  // Code oublié : réinitialisation par variable d'environnement (accès hébergeur requis)
  await s.stop();
  raw.prepare('UPDATE billing_lock SET locked_until = 0').run();
  s = await startServer({ dataDir, env: { BILLING_LOCK_RESET: 'oubli-2026-10' } });
  await s.call('POST', '/api/admin/login', { password: 'secret123' });
  r = await s.call('GET', `${B}/lock/status`);
  assert.equal(r.data.configured, false, 'code effacé');
  assert.equal((await s.call('POST', `${B}/lock/setup`, { code: 'tout-neuf-123', confirm: 'tout-neuf-123' })).status, 201);
  // Même variable au redémarrage suivant : ne ré-efface pas
  await s.stop();
  s = await startServer({ dataDir, env: { BILLING_LOCK_RESET: 'oubli-2026-10' } });
  await s.call('POST', '/api/admin/login', { password: 'secret123' });
  assert.equal((await s.call('GET', `${B}/lock/status`)).data.configured, true);
  raw.close();
  await s.stop();
});

test('verrou : expiration par inactivité (logique pure)', () => {
  const lock = require('../src/billing/lock');
  const req = { session: {} };
  const t0 = 1_000_000;
  assert.equal(lock.isUnlocked(req, t0), false);
  lock.unlockSession(req, t0);
  assert.equal(lock.isUnlocked(req, t0 + lock.IDLE_MS), true, 'juste dans la fenêtre');
  assert.equal(lock.isUnlocked(req, t0 + lock.IDLE_MS + 1), false, 'expiré après inactivité');
  // Feu vert : expire au bout de 90 s et ne sert qu'une fois
  lock.unlockSession(req, t0);
  lock.grant(req, 'fec:2026', t0);
  assert.equal(lock.consumeGrant(req, 'fec:2026', t0 + lock.GRANT_MS + 1), false);
  lock.grant(req, 'fec:2026', t0);
  assert.equal(lock.consumeGrant(req, 'fec:2026', t0 + 1000), true);
  assert.equal(lock.consumeGrant(req, 'fec:2026', t0 + 1000), false);
});
