// RH : collaborateurs rattachés à une BU / une machine, tablette de badgeuse (jeton, code personnel, badge),
// pointages (arrivée, changement de poste, pause, départ, oubli), heures par BU et machine, export.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const { startServer } = require('./helpers');

const parisDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const yesterday = () => parisDate(Date.now() - 86400000);

let s, admin;
// Appel à la badgeuse avec le jeton de la tablette (sans cookie de session).
async function kiosk(token, method, url, body) {
  const res = await fetch(s.BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-terminal-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

before(async () => {
  s = await startServer();
  admin = s.call;
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
});
after(() => s.stop());

test('réservé à l\'administrateur, et un parc de machines de départ est posé', async () => {
  const anon = await fetch(s.BASE + '/api/admin/rh/overview');
  assert.equal(anon.status, 401);
  const r = await admin('GET', '/api/admin/rh/overview');
  assert.equal(r.status, 200);
  assert.equal(r.data.machines.length, 7);
  assert.deepEqual(r.data.bus.map(b => b.id), ['lavage', 'sechage', 'finition', 'logistique', 'admin']);
  const l3 = r.data.machines.find(m => m.name === 'Laveuse 3');
  assert.equal(l3.bu, 'lavage'); assert.equal(l3.capacityKg, 33);
});

let machines, lavage1, sechoir1, camille, hugo;
test('collaborateurs : rattachés à une machine (qui impose la BU) ou à une BU seule', async () => {
  machines = (await admin('GET', '/api/admin/rh/overview')).data.machines;
  lavage1 = machines.find(m => m.name === 'Laveuse 1'); sechoir1 = machines.find(m => m.name === 'Séchoir 1');

  // La machine l'emporte sur la BU envoyée.
  let r = await admin('POST', '/api/admin/rh/employees', { firstName: 'Camille', lastName: 'Martin', contract: 'cdi', bu: 'logistique', machineId: lavage1.id, pin: '4827', weeklyHours: 39, hourlyCost: '17,5' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  camille = r.data.employee;
  assert.equal(camille.bu, 'lavage'); assert.equal(camille.machineName, 'Laveuse 1'); assert.equal(camille.hourlyCost, 17.5);
  assert.equal(camille.hasPin, true);

  r = await admin('POST', '/api/admin/rh/employees', { firstName: 'Hugo', lastName: 'Bernard', contract: 'cdd', bu: 'logistique' });
  assert.equal(r.status, 201); hugo = r.data.employee;
  assert.equal(hugo.bu, 'logistique'); assert.equal(hugo.machineId, null); assert.equal(hugo.hasPin, false);

  // Refus : prénom manquant, BU inconnue, machine inexistante, contrat inconnu, heures hors norme.
  for (const bad of [{ lastName: 'X', bu: 'lavage' }, { firstName: 'A', bu: 'cuisine' }, { firstName: 'A', machineId: 9999 }, { firstName: 'A', bu: 'lavage', contract: 'roi' }, { firstName: 'A', bu: 'lavage', weeklyHours: 80 }]) {
    assert.equal((await admin('POST', '/api/admin/rh/employees', bad)).status, 400, JSON.stringify(bad));
  }
});

test('code personnel : règles, jamais renvoyé en clair ni sous forme d\'empreinte', async () => {
  for (const pin of ['1234', '1111', '12', 'abcd', '1234567']) {
    const r = await admin('PUT', `/api/admin/rh/employees/${hugo.id}`, { pin });
    assert.equal(r.status, 400, pin);
  }
  const r = await admin('PUT', `/api/admin/rh/employees/${hugo.id}`, { pin: '7391' });
  assert.equal(r.status, 200); assert.equal(r.data.employee.hasPin, true);
  const raw = JSON.stringify((await admin('GET', '/api/admin/rh/overview')).data);
  assert.ok(!/7391|4827|scrypt|pin_hash|badge_uid_hash/.test(raw), 'aucun secret dans la réponse');
  hugo = r.data.employee;
});

let token;
test('tablette : jeton montré une seule fois, révocable', async () => {
  assert.equal((await admin('POST', '/api/admin/rh/terminals', {})).status, 400);
  const r = await admin('POST', '/api/admin/rh/terminals', { label: 'Atelier — entrée' });
  assert.equal(r.status, 201); token = r.data.token;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(r.data.path, `/badgeuse#${token}`);
  const list = JSON.stringify((await admin('GET', '/api/admin/rh/terminals')).data);
  assert.ok(!list.includes(token), 'le jeton n\'est plus affiché');

  assert.equal((await kiosk(null, 'GET', '/api/badgeuse/state')).status, 401);
  assert.equal((await kiosk('0'.repeat(64), 'GET', '/api/badgeuse/state')).status, 401);
  const st = await kiosk(token, 'GET', '/api/badgeuse/state');
  assert.equal(st.status, 200);
  assert.equal(st.data.employees.length, 2);
  assert.equal(st.data.machines.length, 7);
  assert.ok(!/pin|hash/i.test(JSON.stringify(st.data).replace(/hasPin/g, '')), 'la tablette ne reçoit aucun secret');

  const t2 = (await admin('POST', '/api/admin/rh/terminals', { label: 'À retirer' })).data;
  assert.equal((await kiosk(t2.token, 'GET', '/api/badgeuse/state')).status, 200);
  assert.equal((await admin('DELETE', `/api/admin/rh/terminals/${t2.terminal.id}`)).status, 200);
  const rev = await kiosk(t2.token, 'GET', '/api/badgeuse/state');
  assert.equal(rev.status, 401); assert.equal(rev.data.code, 'TERMINAL_REVOKED');
});

test('identification : mauvais code refusé, blocage après 5 essais, déblocage par l\'administrateur', async () => {
  const noPin = await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: hugo.id + 100, pin: '7391' });
  assert.equal(noPin.status, 401);
  const rien = (await admin('POST', '/api/admin/rh/employees', { firstName: 'Sans', bu: 'admin' })).data.employee;
  const np = await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: rien.id, pin: '1357' });
  assert.equal(np.status, 403); assert.equal(np.data.code, 'NO_PIN');

  let r = await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: camille.id, pin: '4827' });
  assert.equal(r.status, 200); assert.equal(r.data.employee.name, 'Camille Martin'); assert.equal(r.data.present, null);

  for (let i = 0; i < 4; i++) assert.equal((await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: camille.id, pin: '0001' })).data.code, 'BAD_PIN');
  r = await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: camille.id, pin: '0001' });
  assert.equal(r.status, 429); assert.equal(r.data.code, 'LOCKED');
  // Même avec le bon code, c'est bloqué…
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: camille.id, pin: '4827' })).status, 429);
  // … et l'administrateur le voit et le débloque.
  assert.equal((await admin('GET', '/api/admin/rh/overview')).data.employees.find(e => e.id === camille.id).locked, true);
  assert.equal((await admin('POST', `/api/admin/rh/employees/${camille.id}/unlock`)).status, 200);
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: camille.id, pin: '4827' })).status, 200);
});

test('pointage : arrivée, doublon, changement de poste, pause, retour, départ', async () => {
  const auth = { employeeId: camille.id, pin: '4827' };
  // Sans préciser de poste : celui du collaborateur (Laveuse 1).
  let r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'in' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.present.machineName, 'Laveuse 1'); assert.equal(r.data.present.bu, 'lavage');
  assert.match(r.data.message, /Arrivée enregistrée à \d\d:\d\d — Laveuse 1 · Lavage/);

  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'in' });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'ALREADY_IN');
  assert.equal((await kiosk(token, 'GET', '/api/badgeuse/state')).data.employees.find(e => e.id === camille.id).present.machineName, 'Laveuse 1');

  // Même poste : refusé. Autre machine d'une autre BU : accepté.
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'switch', machineId: lavage1.id })).data.code, 'SAME_POSTE');
  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'switch', machineId: sechoir1.id });
  assert.equal(r.status, 200); assert.equal(r.data.present.poste, 'Séchoir 1 · Séchage');
  // BU seule
  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'switch', bu: 'logistique' });
  assert.equal(r.data.present.poste, 'Logistique'); assert.equal(r.data.present.machineId, null);

  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'pause' });
  assert.equal(r.status, 200); assert.equal(r.data.present, null);
  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'in', bu: 'finition' });
  assert.equal(r.data.present.poste, 'Finition');
  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'out' });
  assert.equal(r.status, 200); assert.match(r.data.message, /Départ enregistré/);
  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'out' });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'NOT_IN');
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/punch', { ...auth, action: 'danser' })).status, 400);
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/punch', { employeeId: camille.id, pin: '9999', action: 'in' })).status, 401);

  // 4 tronçons enregistrés (Laveuse 1, Séchoir 1, Logistique, Finition), tous refermés, avec leurs motifs.
  const day = parisDate(Date.now());
  const e = (await admin('GET', `/api/admin/rh/entries?from=${day}&to=${day}&employeeId=${camille.id}`)).data.entries;
  assert.equal(e.length, 4);
  assert.deepEqual(e.map(x => x.endReason).sort(), ['depart', 'pause', 'poste', 'poste']);
  assert.ok(e.every(x => x.endedAt && !x.open));
});

test('badge : attribué à un seul collaborateur, identifie sans code', async () => {
  let r = await admin('PUT', `/api/admin/rh/employees/${camille.id}`, { badgeUid: '04:A3:2F:19' });
  assert.equal(r.status, 200); assert.equal(r.data.employee.badgeHint, '…2F19');
  assert.equal((await admin('PUT', `/api/admin/rh/employees/${hugo.id}`, { badgeUid: '04a32f19' })).status, 400);   // déjà attribué
  assert.equal((await admin('PUT', `/api/admin/rh/employees/${hugo.id}`, { badgeUid: '12' })).status, 400);

  r = await kiosk(token, 'POST', '/api/badgeuse/identify', { uid: '04A32F19\n' });
  assert.equal(r.status, 200); assert.equal(r.data.employee.id, camille.id);
  r = await kiosk(token, 'POST', '/api/badgeuse/punch', { uid: '04A32F19', action: 'in' });
  assert.equal(r.status, 200); assert.equal(r.data.present.machineName, 'Laveuse 1');
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/punch', { uid: '04A32F19', action: 'out' })).status, 200);
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/identify', { uid: 'FFFF0000' })).data.code, 'BAD_BADGE');
  // Retrait du badge
  assert.equal((await admin('PUT', `/api/admin/rh/employees/${camille.id}`, { badgeUid: '' })).data.employee.badgeHint, null);
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/identify', { uid: '04A32F19' })).status, 401);
});

test('oubli de badge : le tronçon resté ouvert la veille ne compte pas et est signalé', async () => {
  const db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  const startedAt = new Date(Date.now() - 30 * 3600e3).toISOString();
  const info = db.prepare(`INSERT INTO time_entries (employee_id, started_at, bu, machine_id, source) VALUES (?, ?, 'lavage', ?, 'badgeuse')`).run(hugo.id, startedAt, lavage1.id);
  db.close();

  const ov = (await admin('GET', '/api/admin/rh/overview')).data;
  assert.equal(ov.toFix, 1);
  assert.equal(ov.employees.find(e => e.id === hugo.id).present.stale, true);
  assert.equal((await kiosk(token, 'GET', '/api/badgeuse/state')).data.employees.find(e => e.id === hugo.id).present, null);
  const fix = (await admin('GET', '/api/admin/rh/entries/to-fix')).data.entries;
  assert.equal(fix.length, 1); assert.equal(fix[0].id, Number(info.lastInsertRowid)); assert.equal(fix[0].minutes, 0);

  // Il peut pointer normalement : l'ancien tronçon est refermé pour une durée nulle.
  const r = await kiosk(token, 'POST', '/api/badgeuse/punch', { employeeId: hugo.id, pin: '7391', action: 'in' });
  assert.equal(r.status, 200); assert.match(r.data.message, /veille non badgé/);
  assert.equal(r.data.present.poste, 'Logistique');
  const fix2 = (await admin('GET', '/api/admin/rh/entries/to-fix')).data.entries;
  assert.equal(fix2.length, 1); assert.equal(fix2[0].endReason, 'oubli'); assert.equal(fix2[0].open, false);

  // Correction par l'administrateur : plus à corriger.
  const d = fix2[0].date;
  const put = await admin('PUT', `/api/admin/rh/entries/${fix2[0].id}`, { date: d, start: fix2[0].start, end: '23:59', bu: 'lavage', machineId: lavage1.id });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal((await admin('GET', '/api/admin/rh/entries/to-fix')).data.entries.length, 0);
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/punch', { employeeId: hugo.id, pin: '7391', action: 'out' })).status, 200);
});

test('heures : par collaborateur, BU et machine, semaine au-delà du contrat, coût', async () => {
  const hours = (await admin('POST', '/api/admin/rh/employees', { firstName: 'Zoé', lastName: 'Petit', contract: 'cdd', bu: 'finition', weeklyHours: 5, hourlyCost: 20 })).data.employee;
  const day = yesterday();
  const cal = machines.find(m => m.name === 'Calandre 320 cm');
  let r = await admin('POST', '/api/admin/rh/entries', { employeeId: hours.id, date: day, start: '06:00', end: '10:00', machineId: cal.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.entry.minutes, 240); assert.equal(r.data.entry.bu, 'finition'); assert.equal(r.data.entry.source, 'manuel');
  r = await admin('POST', '/api/admin/rh/entries', { employeeId: hours.id, date: day, start: '10:30', end: '14:30', bu: 'logistique' });
  assert.equal(r.status, 201);

  // Refus : chevauchement, départ avant l'arrivée, heure mal écrite, futur, jour passé sans heure de départ.
  assert.equal((await admin('POST', '/api/admin/rh/entries', { employeeId: hours.id, date: day, start: '09:00', end: '11:00', bu: 'finition' })).status, 409);
  assert.equal((await admin('POST', '/api/admin/rh/entries', { employeeId: hours.id, date: day, start: '15:00', end: '14:00', bu: 'finition' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/rh/entries', { employeeId: hours.id, date: day, start: '6h', end: '14:00', bu: 'finition' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/rh/entries', { employeeId: hours.id, date: day, start: '16:00', bu: 'finition' })).status, 400);
  const future = parisDate(Date.now() + 3 * 86400000);
  assert.equal((await admin('POST', '/api/admin/rh/entries', { employeeId: hours.id, date: future, start: '06:00', end: '10:00', bu: 'finition' })).status, 400);

  const h = (await admin('GET', `/api/admin/rh/hours?from=${day}&to=${day}`)).data;
  const z = h.employees.find(e => e.id === hours.id);
  assert.equal(z.total, 480); assert.equal(z.days[day], 480);
  assert.equal(z.weeks.reduce((a, w) => a + w.min, 0), 480);
  assert.equal(z.costCents, 16000);                       // 8 h × 20 €
  assert.equal(h.byBu.find(b => b.bu === 'finition').min, 240);
  assert.equal(h.byBu.find(b => b.bu === 'logistique').min >= 240, true);
  const calRow = h.byMachine.find(m => m.machineId === cal.id);
  assert.equal(calRow.min, 240); assert.equal(calRow.name, 'Calandre 320 cm');
  assert.ok(h.byMachine.find(m => m.machineId === null && m.bu === 'logistique'), 'ligne « unité entière » pour une BU sans machine');
  assert.equal(h.total, h.byBu.reduce((a, b) => a + b.min, 0));

  // Export : BOM, « ; », virgule décimale, heures au-delà du contrat (8 h − 5 h = 3 h).
  const anon = await fetch(s.BASE + `/api/admin/rh/export.csv?from=${day}&to=${day}&kind=summary`);
  assert.equal(anon.status, 401, 'sans session, pas de fichier');
  const res = await admin('GET', `/api/admin/rh/export.csv?from=${day}&to=${day}&kind=summary`, null, true);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="heures-/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM pour Excel');
  const text = buf.toString('utf8');
  const line = text.split('\r\n').find(l => l.startsWith('Zoé Petit'));
  assert.ok(line, text);
  assert.match(line, /^Zoé Petit;CDD;Finition;5;8,00;8,00;3,00$/);
  const det = await (await admin('GET', `/api/admin/rh/export.csv?from=${day}&to=${day}&kind=detail`, null, true)).text();
  assert.match(det, /Zoé Petit;Finition;Calandre 320 cm;06:00;10:00;4,00;Départ;Manuelle/);

  // Une cellule qui ressemblerait à une formule est neutralisée.
  const evil = (await admin('POST', '/api/admin/rh/employees', { firstName: '=1+1', lastName: 'Test', bu: 'admin' })).data.employee;
  await admin('POST', '/api/admin/rh/entries', { employeeId: evil.id, date: day, start: '08:00', end: '09:00', bu: 'admin' });
  const csv2 = await (await admin('GET', `/api/admin/rh/export.csv?from=${day}&to=${day}&kind=detail`, null, true)).text();
  assert.ok(csv2.includes("'=1+1 Test"), 'formule neutralisée');
  assert.ok(!csv2.includes(';=1+1'), 'aucune cellule ne commence par =');

  // Période invalide ou trop longue.
  assert.equal((await admin('GET', '/api/admin/rh/hours?from=2026-01-01&to=2026-12-31')).status, 400);
  assert.equal((await admin('GET', '/api/admin/rh/hours?from=nimporte&to=quoi')).status, 400);
});

test('machines : renommer suit les collaborateurs, retrait sans perte d\'historique', async () => {
  // Changer la BU d'une machine déplace ceux qui y sont rattachés.
  let r = await admin('PUT', `/api/admin/rh/machines/${lavage1.id}`, { bu: 'sechage' });
  assert.equal(r.status, 200);
  assert.equal((await admin('GET', '/api/admin/rh/overview')).data.employees.find(e => e.id === camille.id).bu, 'sechage');
  await admin('PUT', `/api/admin/rh/machines/${lavage1.id}`, { bu: 'lavage' });

  r = await admin('POST', '/api/admin/rh/machines', { name: 'Presse', bu: 'finition', capacityKg: '12,5' });
  assert.equal(r.status, 201); assert.equal(r.data.machine.capacityKg, 12.5);
  const fresh = r.data.machine;
  assert.equal((await admin('POST', '/api/admin/rh/machines', { name: '', bu: 'finition' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/rh/machines', { name: 'X', bu: 'nulle-part' })).status, 400);
  assert.equal((await admin('DELETE', `/api/admin/rh/machines/${fresh.id}`)).data.archived, false);   // jamais utilisée : supprimée
  const used = await admin('DELETE', `/api/admin/rh/machines/${lavage1.id}`);                          // utilisée : retirée, historique gardé
  assert.equal(used.data.archived, true);
  const ov = (await admin('GET', '/api/admin/rh/overview')).data;
  assert.equal(ov.machines.find(m => m.id === lavage1.id).active, false);
  assert.equal(ov.employees.find(e => e.id === camille.id).machineId, null);
  assert.equal((await kiosk(token, 'GET', '/api/badgeuse/state')).data.machines.some(m => m.id === lavage1.id), false);
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/punch', { employeeId: camille.id, pin: '4827', action: 'in', machineId: lavage1.id })).status, 400);
});

test('archivage : le collaborateur ne peut plus pointer, ses heures restent', async () => {
  await kiosk(token, 'POST', '/api/badgeuse/punch', { employeeId: hugo.id, pin: '7391', action: 'in' });
  const r = await admin('DELETE', `/api/admin/rh/employees/${hugo.id}`);
  assert.equal(r.status, 200); assert.equal(r.data.employee.active, false); assert.equal(r.data.employee.present, null);
  assert.equal((await kiosk(token, 'POST', '/api/badgeuse/identify', { employeeId: hugo.id, pin: '7391' })).status, 401);
  assert.equal((await kiosk(token, 'GET', '/api/badgeuse/state')).data.employees.some(e => e.id === hugo.id), false);
  const day = parisDate(Date.now());
  const e = (await admin('GET', `/api/admin/rh/entries?from=${day}&to=${day}&employeeId=${hugo.id}`)).data.entries;
  assert.ok(e.length >= 1 && e.every(x => x.endedAt), 'tronçon refermé');
  // Réactivation
  assert.equal((await admin('PUT', `/api/admin/rh/employees/${hugo.id}`, { active: true })).data.employee.active, true);
});

test('la page de la tablette est servie, sans script en ligne', async () => {
  const res = await fetch(s.BASE + '/badgeuse');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await res.text();
  assert.ok(/<script src="\/badgeuse\.js"><\/script>/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'aucun script en ligne');
  assert.ok(!/\son(click|load|error)=/i.test(html), 'aucun gestionnaire en ligne');
});
