// Espace client de bout en bout par l'API : connexion protégée contre les essais répétés, coordonnées, changement de
// code, code oublié par e-mail (faux serveur SMTP), factures avec statut, reste dû et offre d'escompte.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { startServer } = require('./helpers');

// nodemailer encode en quoted-printable (« = » devient « =3D », lignes coupées par « =⏎ ») : on remet à plat pour lire le lien.
function decodeQp(t) {
  if (!/quoted-printable/i.test(t)) return t;
  return t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ---- faux serveur SMTP : accepte tout, garde les messages reçus ----
function fakeSmtp() {
  const mails = [];
  const server = net.createServer(sock => {
    let data = ''; let inData = false; let authStep = 0; let cur = { to: [], body: '' };
    const send = (l) => sock.write(l + '\r\n');
    send('220 fake ESMTP');
    sock.on('data', chunk => {
      data += chunk.toString('utf8');
      let i;
      while ((i = data.indexOf('\r\n')) >= 0) {
        const line = data.slice(0, i); data = data.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; cur.body = decodeQp(cur.body); mails.push(cur); cur = { to: [], body: '' }; send('250 OK'); } else cur.body += line + '\n';
          continue;
        }
        if (authStep === 1) { authStep = 2; send('334 UGFzc3dvcmQ6'); continue; }
        if (authStep === 2) { authStep = 0; send('235 OK'); continue; }
        const u = line.toUpperCase();
        if (u.startsWith('EHLO')) { sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n'); }
        else if (u.startsWith('HELO')) send('250 fake');
        else if (u === 'AUTH LOGIN') { authStep = 1; send('334 VXNlcm5hbWU6'); }
        else if (u.startsWith('AUTH PLAIN')) send('235 OK');
        else if (u.startsWith('MAIL FROM')) send('250 OK');
        else if (u.startsWith('RCPT TO')) { cur.to.push(line.slice(line.indexOf('<') + 1, line.indexOf('>'))); send('250 OK'); }
        else if (u === 'DATA') { inData = true; send('354 go'); }
        else if (u === 'QUIT') { send('221 bye'); sock.end(); }
        else send('250 OK');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ mails, port: server.address().port, close: () => server.close() })));
}

const CODE = 'code-facturation-1';
const B = '/api/admin/billing';
let s; let db; let smtp; let hotel; let other; let verrou;
const call = (...a) => s.call(...a);

test.before(async () => {
  smtp = await fakeSmtp();
  s = await startServer({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'cezanne@test.fr', PUBLIC_URL: 'https://cezanne.test/' } });
  assert.equal((await call('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  assert.equal((await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const mk = (mail, name) => Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash, siret, tva_number, adresse_facturation, code_postal, ville)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(mail, name, 'Jean', '0490123456', '1 rue Test', bcrypt.hashSync('1234', 10), '55210055400013', 'FR40552100554', 'Siège', '84000', 'Avignon').lastInsertRowid);
  hotel = mk('lavandes@x.fr', 'Hôtel des Lavandes'); other = mk('ventoux@x.fr', 'Hôtel du Ventoux'); verrou = mk('verrou@x.fr', 'Hôtel du Verrou');
  const c = await call('POST', `${B}/lock/confirm`, { code: CODE, scope: 'settings' });
  assert.equal(c.status, 200);
  const r = await call('PUT', `${B}/settings`, { share_capital: '10 000 €', siren: '552 100 554', siret: '55210055400013', vat_number: 'FR40552100554', rcs: 'RCS Avignon', iban: 'FR76 3000 1007 9412 3456 7890 185', bic: 'BDFEFRPP', phone: '04 90 00 00 00', email: 'contact@cezanne.test', early_discount_rate: '1,5', early_discount_hours: 48 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); if (smtp) smtp.close(); });

const login = (email = 'lavandes@x.fr', code = '1234') => call('POST', '/api/clients/login', { email, code });

test('connexion : bon code accepté, mauvais code refusé, puis blocage après 5 échecs (même avec le bon code)', async () => {
  s.newClient();
  assert.equal((await login('verrou@x.fr')).status, 200);
  s.newClient();
  for (let i = 1; i <= 4; i++) {
    const r = await login('verrou@x.fr', '0000');
    assert.equal(r.status, 401, `essai ${i}`);
    assert.match(r.data.error, /incorrect/);
  }
  const fifth = await login('verrou@x.fr', '0001');
  assert.equal(fifth.status, 429);
  assert.match(fifth.data.error, /Trop d'essais.*15 minutes/);
  const right = await login('verrou@x.fr', '1234');
  assert.equal(right.status, 429, 'le bon code ne passe pas pendant le blocage');
  // Un autre hôtel n'est pas touché ; une adresse inconnue est limitée de la même façon (aucune fuite d'existence)
  assert.equal((await login('ventoux@x.fr', '1234')).status, 200);
  s.newClient();
  for (let i = 0; i < 4; i++) assert.equal((await login('inconnu@x.fr', '0000')).status, 401);
  assert.equal((await login('inconnu@x.fr', '0000')).status, 429);
});

test('options de connexion : le code oublié par e-mail est proposé car l\'envoi est configuré', async () => {
  const r = await call('GET', '/api/clients/auth-options');
  assert.equal(r.data.resetByEmail, true);
  assert.equal(r.data.contact.phone, '04 90 00 00 00');
});

test('coordonnées : modifiables, nom de l\'établissement protégé, changement d\'e-mail soumis au code', async () => {
  s.newClient();
  assert.equal((await login('ventoux@x.fr')).status, 200);
  const ok = await call('PUT', '/api/clients/me/profile', { contact: 'Marie Roux', tel: '06 11 22 33 44', adresse: '5 place du Marché, 84200 Carpentras' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.client.contact, 'Marie Roux');
  assert.equal(ok.data.client.societe, 'Hôtel du Ventoux');
  const row = db.prepare('SELECT societe, contact, tel, adresse FROM clients WHERE id = ?').get(other);
  assert.deepEqual({ ...row }, { societe: 'Hôtel du Ventoux', contact: 'Marie Roux', tel: '06 11 22 33 44', adresse: '5 place du Marché, 84200 Carpentras' });
  // le nom ne se change pas par ici
  await call('PUT', '/api/clients/me/profile', { societe: 'Autre nom', contact: 'Marie Roux' });
  assert.equal(db.prepare('SELECT societe FROM clients WHERE id = ?').get(other).societe, 'Hôtel du Ventoux');
  // champs vides refusés
  assert.equal((await call('PUT', '/api/clients/me/profile', { contact: '  ' })).status, 400);
  assert.equal((await call('PUT', '/api/clients/me/profile', { tel: '' })).status, 400);
  // e-mail : sans code → 403 ; mauvais code → 403 ; format invalide → 400 ; déjà pris → 409 ; bon code → 200
  assert.equal((await call('PUT', '/api/clients/me/profile', { email: 'nouveau@x.fr' })).status, 403);
  assert.equal((await call('PUT', '/api/clients/me/profile', { email: 'nouveau@x.fr', currentCode: '9999' })).status, 403);
  assert.equal((await call('PUT', '/api/clients/me/profile', { email: 'pas-un-mail', currentCode: '1234' })).status, 400);
  assert.equal((await call('PUT', '/api/clients/me/profile', { email: 'lavandes@x.fr', currentCode: '1234' })).status, 409);
  const mail = await call('PUT', '/api/clients/me/profile', { email: 'Nouveau@X.fr', currentCode: '1234' });
  assert.equal(mail.status, 200, JSON.stringify(mail.data));
  assert.equal(db.prepare('SELECT email FROM clients WHERE id = ?').get(other).email, 'nouveau@x.fr');
  assert.ok(db.prepare("SELECT 1 FROM billing_events WHERE action = 'client_self_updated' LIMIT 1").get(), 'changement tracé au journal');
  // sans connexion : refusé
  s.newClient();
  assert.equal((await call('PUT', '/api/clients/me/profile', { contact: 'X' })).status, 401);
  db.prepare("UPDATE clients SET email = 'ventoux@x.fr' WHERE id = ?").run(other);
});

test('changer son code : ancien code exigé, nouveau code validé, ancien code inutilisable ensuite', async () => {
  s.newClient();
  assert.equal((await login('ventoux@x.fr')).status, 200);
  assert.equal((await call('PUT', '/api/clients/me/code', { currentCode: '0000', newCode: '5678' })).status, 403);
  assert.equal((await call('PUT', '/api/clients/me/code', { currentCode: '1234', newCode: '12' })).status, 400);
  assert.equal((await call('PUT', '/api/clients/me/code', { currentCode: '1234', newCode: 'abcd' })).status, 400);
  assert.equal((await call('PUT', '/api/clients/me/code', { currentCode: '1234', newCode: '5678' })).status, 200);
  s.newClient();
  assert.equal((await login('ventoux@x.fr', '1234')).status, 401);
  assert.equal((await login('ventoux@x.fr', '5678')).status, 200);
  // les essais de l'ancien code sont limités aussi
  for (let i = 0; i < 4; i++) assert.equal((await call('PUT', '/api/clients/me/code', { currentCode: '0000', newCode: '4321' })).status, 403);
  assert.equal((await call('PUT', '/api/clients/me/code', { currentCode: '0000', newCode: '4321' })).status, 429);
  assert.ok(db.prepare("SELECT 1 FROM billing_events WHERE action = 'client_code_changed' LIMIT 1").get());
  db.prepare('UPDATE clients SET code_hash = ? WHERE id = ?').run(bcrypt.hashSync('1234', 10), other);
});

test('code oublié : lien envoyé par e-mail, à usage unique, valable une heure ; aucune fuite sur l\'existence du compte', async () => {
  s.newClient();
  // adresse inconnue : même réponse, aucun e-mail
  const before = smtp.mails.length;
  const unknown = await call('POST', '/api/clients/forgot-code', { email: 'personne@x.fr' });
  assert.equal(unknown.status, 200);
  assert.match(unknown.data.message, /Si un compte existe/);
  assert.equal(smtp.mails.length, before);
  assert.equal((await call('POST', '/api/clients/forgot-code', { email: 'pas-un-mail' })).status, 400);

  // adresse connue : même réponse, un e-mail part avec un lien
  const known = await call('POST', '/api/clients/forgot-code', { email: 'LAVANDES@x.fr' });
  assert.equal(known.status, 200);
  assert.equal(known.data.message, unknown.data.message);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(smtp.mails.length, before + 1);
  const mail = smtp.mails.at(-1);
  assert.deepEqual(mail.to, ['lavandes@x.fr']);
  const m = mail.body.match(/https:\/\/cezanne\.test\/#reset=([A-Za-z0-9_-]{43})/);
  assert.ok(m, 'lien avec jeton de 256 bits : ' + mail.body.slice(0, 300));
  const token = m[1];
  // le jeton n'est jamais stocké en clair
  const stored = db.prepare('SELECT token_hash FROM client_reset_tokens WHERE client_id = ?').all(hotel);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, token);
  assert.match(stored[0].token_hash, /^[0-9a-f]{64}$/);

  // mauvais jeton / mauvais code
  assert.equal((await call('POST', '/api/clients/reset-code', { token: 'n-importe-quoi', code: '4321' })).status, 400);
  assert.equal((await call('POST', '/api/clients/reset-code', { token, code: 'ab' })).status, 400);
  // bon jeton : nouveau code, puis le jeton est mort
  const done = await call('POST', '/api/clients/reset-code', { token, code: '4321' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await call('POST', '/api/clients/reset-code', { token, code: '9999' })).status, 400, 'usage unique');
  s.newClient();
  assert.equal((await login('lavandes@x.fr', '1234')).status, 401);
  assert.equal((await login('lavandes@x.fr', '4321')).status, 200);
  db.prepare('UPDATE clients SET code_hash = ? WHERE id = ?').run(bcrypt.hashSync('1234', 10), hotel);
});

test('code oublié : un jeton expiré est refusé', async () => {
  s.newClient();
  await call('POST', '/api/clients/forgot-code', { email: 'ventoux@x.fr' });
  await new Promise(r => setTimeout(r, 200));
  const token = smtp.mails.at(-1).body.match(/#reset=([A-Za-z0-9_-]+)/)[1];
  db.prepare("UPDATE client_reset_tokens SET expires_at = datetime('now', '-1 minute') WHERE client_id = ?").run(other);
  const r = await call('POST', '/api/clients/reset-code', { token, code: '4321' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /n'est plus valable/);
});

// ---- factures ----
let day = 0;
async function newInvoice(clientId, issueDate) {
  day += 1;
  const o = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES (?,?,?,?,?,?,?,'livree')`).run(`CZ-P-${day}`, clientId, 'H', 'J', '06', 'adr', issueDate).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(o, 'd', 'Drap', 'D', 'DRAP', 1, 100, 100);
  const c = await call('POST', `${B}/invoices`, { clientId, orderIds: [o] });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.invoice.id;
  const k = await call('POST', `${B}/lock/confirm`, { code: CODE, scope: `issue:${id}` });
  assert.equal(k.status, 200);
  const i = await call('POST', `${B}/invoices/${id}/issue`, { issueDate });
  assert.equal(i.status, 200, JSON.stringify(i.data));
  return { id, number: i.data.invoice.number };
}

test('factures : statut, échéance, TTC, reste dû, offre d\'escompte ouverte et coordonnées de virement', async () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const ago = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  // admin pour émettre
  s.newClient();
  assert.equal((await call('POST', '/api/admin/login', { password: 'secret123' })).status, 200);
  assert.equal((await call('POST', `${B}/lock/unlock`, { code: CODE })).status, 200);
  const oldOne = await newInvoice(hotel, ago(60));      // échue depuis 30 jours, offre expirée
  const fresh = await newInvoice(hotel, today);         // offre ouverte
  const paid = await newInvoice(hotel, today);
  const none = await newInvoice(other, today);          // d'un autre hôtel
  await call('POST', `${B}/invoices/${paid.id}/payments`, { paidOn: today, method: 'virement', withDiscount: true });
  const partial = await newInvoice(hotel, today);
  await call('POST', `${B}/invoices/${partial.id}/payments`, { paidOn: today, amount: 50, method: 'virement' });

  s.newClient();
  assert.equal((await call('GET', '/api/clients/invoices')).status, 401);
  assert.equal((await login('lavandes@x.fr')).status, 200);
  const r = await call('GET', '/api/clients/invoices');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const by = (n) => r.data.invoices.find(i => i.number === n);
  assert.equal(r.data.invoices.length, 4, 'seulement les factures de cet hôtel');
  assert.ok(!by(none.number), 'jamais les factures d\'un autre hôtel');

  const o = by(oldOne.number);
  assert.equal(o.status, 'overdue'); assert.equal(o.totalTtcCents, 12000); assert.equal(o.balanceCents, 12000);
  assert.equal(o.overdueDays, 30); assert.equal(o.escompte, null, 'délai passé : plus d\'offre');
  const f = by(fresh.number);
  assert.equal(f.status, 'unpaid');
  assert.equal(f.dueDate, ago(-30));
  assert.deepEqual({ ...f.escompte }, { ratePct: 1.5, deadline: ago(-2), discountCents: 180, netCents: 11820 });
  const p = by(paid.number);
  assert.equal(p.status, 'paid'); assert.equal(p.balanceCents, 0); assert.equal(p.escompte, null); assert.equal(p.grantedDiscountCents, 180);
  const pa = by(partial.number);
  assert.equal(pa.status, 'partial'); assert.equal(pa.balanceCents, 7000);

  assert.deepEqual({ ...r.data.summary }, { dueCents: 12000 + 12000 + 7000, overdueCents: 12000, openCount: 3 });
  assert.equal(r.data.payment.iban, 'FR76 3000 1007 9412 3456 7890 185');
  assert.equal(r.data.payment.bic, 'BDFEFRPP');

  // PDF du portail : son propre document oui, celui d'un autre hôtel non
  const pdf = await call('GET', `/api/clients/native-invoices/${paid.id}/pdf`, null, true);
  assert.equal(pdf.status, 200);
  assert.equal((await call('GET', `/api/clients/native-invoices/${none.id}/pdf`)).status, 404);

  // L'autre hôtel : pas d'IBAN affiché s'il n'a rien à payer
  s.newClient();
  assert.equal((await login('ventoux@x.fr')).status, 200);
  const r2 = await call('GET', '/api/clients/invoices');
  assert.equal(r2.data.invoices.length, 1);
  assert.equal(r2.data.summary.dueCents, 12000);
});

test('code oublié indisponible sans e-mail configuré : 503 et coordonnées de l\'établissement', async () => {
  const bare = await startServer({ env: { SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, PUBLIC_URL: undefined, RENDER_EXTERNAL_URL: undefined } });
  try {
    const o = await bare.call('GET', '/api/clients/auth-options');
    assert.equal(o.data.resetByEmail, false);
    const r = await bare.call('POST', '/api/clients/forgot-code', { email: 'lavandes@x.fr' });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /Blanchisserie Cézanne/);
  } finally { await bare.stop(); }
});
