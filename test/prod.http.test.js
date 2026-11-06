// Production : lots de lavage (un ou plusieurs clients), passages lavage / séchage / finition sur les machines,
// contrôles de capacité et d'occupation, pannes, remarques, saisie à la main, coût, heures et tableau de bord.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('path');
const { startServer } = require('./helpers');

const parisDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const yesterday = () => parisDate(Date.now() - 86400000);
const A = '/api/admin/atelier';
const T = '/api/atelier';

let s, admin, token, db;
async function tablet(method, url, body, tok = token) {
  const res = await fetch(s.BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { 'x-terminal-token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const AUTH = {};   // employeeId + pin de Camille, renseigné plus bas
const act = (method, url, body) => tablet(method, url, { ...AUTH, ...(body || {}) });

before(async () => {
  s = await startServer();
  admin = s.call;
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
});
after(() => { try { db.close(); } catch {} return s.stop(); });

let M, hotel, other, types, camille;
const mach = (name) => M.find(m => m.name === name);

test('accès : l\'administration exige la session, la tablette exige son jeton et le code du collaborateur', async () => {
  assert.equal((await fetch(s.BASE + A + '/overview')).status, 401);
  assert.equal((await tablet('GET', T + '/state', null, null)).status, 401);
  assert.equal((await tablet('GET', T + '/state', null, '0'.repeat(64))).status, 401);

  M = (await admin('GET', '/api/admin/rh/overview')).data.machines;
  camille = (await admin('POST', '/api/admin/rh/employees', { firstName: 'Camille', lastName: 'Martin', contract: 'cdi', machineId: mach('Laveuse 1').id, pin: '4827', hourlyCost: '20' })).data.employee;
  await admin('POST', '/api/admin/rh/employees', { firstName: 'Sans', bu: 'admin' });
  token = (await admin('POST', '/api/admin/rh/terminals', { label: 'Atelier' })).data.token;
  Object.assign(AUTH, { employeeId: camille.id, pin: '4827' });

  const st = await tablet('GET', T + '/state');
  assert.equal(st.status, 200);
  assert.equal(st.data.machines.length, 7);
  assert.ok(st.data.machines.every(m => m.state === 'free'));
  assert.ok(!/pin_hash|badge_uid|token_hash|scrypt/.test(JSON.stringify(st.data)), 'aucun secret envoyé à la tablette');

  // Une action sans code, ou avec un mauvais code, est refusée.
  let r = await tablet('POST', T + '/identify', {});
  assert.equal(r.status, 401);
  r = await tablet('POST', T + '/identify', { employeeId: camille.id, pin: '0000' });
  assert.equal(r.status, 401); assert.equal(r.data.code, 'BAD_PIN');
  r = await act('POST', T + '/identify');
  assert.equal(r.status, 200); assert.equal(r.data.employee.name, 'Camille Martin');
});

test('réglages de départ : objectif 1,30 €/kg, horaires 5 h – 21 h, types de linge, cadence des calandres', async () => {
  const r = await admin('GET', A + '/overview');
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.targetCentsPerKg, 130);
  assert.equal(r.data.settings.openFrom, '05:00'); assert.equal(r.data.settings.openTo, '21:00');
  assert.equal(r.data.settings.waterCentsPerM3, null); assert.equal(r.data.settings.energyCentsPerKwh, null);
  types = r.data.linenTypes;
  assert.deepEqual(types.map(t => t.label), ['Grand plat', 'Petit plat', 'Éponge', 'Spa', 'Tenues']);
  assert.equal(mach('Calandre 320 cm').throughputKgh, 45); assert.equal(mach('Calandre 250 cm').throughputKgh, 35);
  assert.equal(mach('Laveuse 1').throughputKgh, null);
});

let prog;
test('programmes, types de linge et prix : saisie contrôlée', async () => {
  assert.equal((await admin('POST', A + '/programs', { durationMin: 45 })).status, 400);
  assert.equal((await admin('POST', A + '/programs', { name: 'X', durationMin: 'abc' })).status, 400);
  let r = await admin('POST', A + '/programs', { name: 'Draps 60°', tempC: 60, durationMin: 45, waterL: 180, energyKwh: '3,5', detergentCost: '0,35' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  prog = r.data.programs.find(p => p.name === 'Draps 60°');
  assert.equal(prog.durationMin, 45); assert.equal(prog.detergentCost, 0.35); assert.equal(prog.energyKwh, 3.5);

  r = await admin('POST', A + '/linen-types', { label: 'Nappes' });
  assert.equal(r.status, 201); assert.equal(r.data.linenTypes.length, 6);
  assert.equal((await admin('POST', A + '/linen-types', { label: 'nappes' })).status, 409);
  assert.equal((await admin('POST', A + '/linen-types', { label: ' ' })).status, 400);

  assert.equal((await admin('PUT', A + '/settings', { waterPrice: '-1' })).status, 400);
  assert.equal((await admin('PUT', A + '/settings', { openFrom: '22:00', openTo: '06:00' })).status, 400);
  r = await admin('PUT', A + '/settings', { waterPrice: '4,2', energyPrice: '0,18' });
  assert.equal(r.status, 200); assert.equal(r.data.settings.waterCentsPerM3, 420); assert.equal(r.data.settings.energyCentsPerKwh, 18);
  assert.equal(r.data.settings.targetCentsPerKg, 130, 'les autres réglages sont conservés');
});

let lot1, lot2;
test('nouveau lot depuis la tablette : un client, poids, laveuse, programme, fin prévue', async () => {
  hotel = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES (?,?,?,?,?, 'x')`).run('h@x.fr', 'Hôtel du Palais', 'C', '06', '1 rue du Test').lastInsertRowid);
  other = Number(db.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_hash) VALUES (?,?,?,?,?, 'x')`).run('o@x.fr', 'Mas des Oliviers', 'C', '06', '2 rue du Test').lastInsertRowid);
  const gp = types.find(t => t.label === 'Grand plat').id;
  const base = { linenTypeId: gp, clients: [{ clientId: hotel }], weightKg: '24,5', machineId: mach('Laveuse 1').id, programId: prog.id };

  // Refus : pas de client, poids nul / absurde, mauvaise machine, capacité dépassée, type inconnu, client inconnu.
  const refus = [
    [{ clients: [] }, 'NO_CLIENT'], [{ weightKg: 0 }, 'BAD_WEIGHT'], [{ weightKg: 9000 }, 'BAD_WEIGHT'], [{ machineId: mach('Séchoir 1').id }, 'WRONG_MACHINE'],
    [{ weightKg: 28 }, 'OVER_CAPACITY'], [{ linenTypeId: 9999 }, 'BAD_TYPE'], [{ clients: [{ clientId: 99999 }] }, 'BAD_CLIENT'], [{ machineId: 9999 }, 'BAD_MACHINE'],
    [{ clients: [{ clientId: hotel, weightKg: 20 }, { societe: 'Autre', weightKg: 10 }] }, 'BAD_WEIGHT'], [{ programId: 9999 }, 'BAD_PROGRAM'],
  ];
  for (const [patch, code] of refus) {
    const r = await act('POST', T + '/lots', { ...base, ...patch });
    assert.equal(r.status, 400, code + ' ' + JSON.stringify(r.data)); assert.equal(r.data.code, code);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lots').get().n, 0, 'rien n\'est créé quand la demande est refusée');

  const r = await act('POST', T + '/lots', base);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  lot1 = r.data.lot;
  assert.match(lot1.code, /^L-\d{4}-01$/);
  assert.equal(lot1.weightKg, 24.5); assert.equal(lot1.status, 'en_cours'); assert.equal(lot1.createdBy, 'Camille Martin');
  assert.equal(lot1.clients.length, 1); assert.equal(lot1.clients[0].societe, 'Hôtel du Palais'); assert.equal(lot1.clients[0].weightKg, 24.5);
  const st = lot1.steps[0];
  assert.equal(st.stage, 'lavage'); assert.equal(st.machineName, 'Laveuse 1'); assert.equal(st.programName, 'Draps 60°'); assert.equal(st.open, true);
  assert.equal(Math.round((Date.parse(st.plannedEndAt) - Date.parse(st.startedAt)) / 1000), 45 * 60);
  assert.match(lot1.stageLabel, /^Lavage · Laveuse 1/);
  assert.equal(r.data.machines.find(m => m.name === 'Laveuse 1').state, 'running');
  assert.equal(r.data.machines.find(m => m.name === 'Laveuse 1').step.lotCode, lot1.code);

  // La machine est prise : un second lot dessus est refusé (409), sur une autre laveuse c'est bon.
  const busy = await act('POST', T + '/lots', { ...base, clients: [{ clientId: other }] });
  assert.equal(busy.status, 409); assert.equal(busy.data.code, 'MACHINE_BUSY');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lots').get().n, 1, 'le lot refusé n\'a rien laissé derrière lui');

  // Lot mélangé : deux clients, dont un hors liste, avec leurs kilos ; le reste n'est pas réparti.
  const mix = await act('POST', T + '/lots', { linenTypeId: types.find(t => t.label === 'Éponge').id, weightKg: 20, machineId: mach('Laveuse 2').id,
    clients: [{ clientId: hotel, weightKg: 10 }, { societe: 'Particulier Dupont', weightKg: '8' }] });
  assert.equal(mix.status, 201, JSON.stringify(mix.data));
  lot2 = mix.data.lot;
  assert.match(lot2.code, /^L-\d{4}-02$/);
  assert.deepEqual(lot2.clients.map(c => [c.societe, c.weightKg]), [['Hôtel du Palais', 10], ['Particulier Dupont', 8]]);
  assert.equal(lot2.steps[0].plannedEndAt, null, 'sans programme, pas de fin prévue');
});

test('avancement : fin du lavage, séchage, finition (fin prévue selon la cadence), clôture', async () => {
  let r = await act('POST', `${T}/steps/${lot1.steps[0].id}/finish`);
  assert.equal(r.status, 200); assert.equal(r.data.lot.waiting, true);
  assert.equal(r.data.machines.find(m => m.name === 'Laveuse 1').state, 'free');
  assert.equal((await act('POST', `${T}/steps/${lot1.steps[0].id}/finish`)).status, 409);

  let w = (await tablet('GET', T + '/state')).data.waiting;
  assert.deepEqual(w.map(x => x.code), [lot1.code]); assert.equal(w[0].lastStage, 'lavage');

  // Séchage : mauvaise machine, capacité, puis OK.
  const dry = (patch) => act('POST', `${T}/lots/${lot1.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 1').id, weightKg: 18, ...patch });
  assert.equal((await dry({ machineId: mach('Laveuse 2').id })).data.code, 'WRONG_MACHINE');
  assert.equal((await dry({ weightKg: 19 })).data.code, 'OVER_CAPACITY');
  assert.equal((await dry({ stage: 'repassage' })).data.code, 'BAD_STAGE');
  assert.equal((await dry({ programId: prog.id })).data.code, 'BAD_PROGRAM');
  r = await dry();
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.lot.current.stage, 'sechage');
  r = await act('POST', `${T}/lots/${lot1.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 2').id, weightKg: 6.5 });   // le reste du lot dans le second séchoir
  assert.equal(r.status, 201);
  for (const st of r.data.lot.steps.filter(x => x.stage === 'sechage')) await act('POST', `${T}/steps/${st.id}/finish`);

  // Finition sur la calandre 320 cm (45 kg/h) : fin prévue = poids / cadence.
  r = await act('POST', `${T}/lots/${lot1.id}/steps`, { stage: 'finition', machineId: mach('Calandre 320 cm').id, weightKg: 24.5 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const f = r.data.lot.current;
  assert.ok(Math.abs((Date.parse(f.plannedEndAt) - Date.parse(f.startedAt)) / 1000 - 24.5 / 45 * 3600) < 2);
  assert.ok(f.remainingMin > 30 && f.remainingMin <= 33);

  r = await act('POST', `${T}/lots/${lot1.id}/close`);
  assert.equal(r.status, 409, 'on ne clôture pas un lot dont un passage tourne');
  r = await act('POST', `${T}/steps/${f.id}/finish`, { closeLot: true });
  assert.equal(r.status, 200); assert.equal(r.data.lot.status, 'termine'); assert.equal(r.data.lot.stageLabel, 'Terminé');
  assert.equal(r.data.lot.steps.length, 4);
  assert.equal((await act('POST', `${T}/lots/${lot1.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 1').id, weightKg: 5 })).data.code, 'LOT_CLOSED');
  w = (await tablet('GET', T + '/state')).data.waiting;
  assert.ok(!w.some(x => x.code === lot1.code), 'un lot terminé n\'est plus à reprendre');
});

test('panne : la machine est à l\'arrêt jusqu\'à sa remise en service', async () => {
  assert.equal((await act('POST', `${T}/machines/${mach('Séchoir 2').id}/incidents`, {})).status, 400);
  let r = await act('POST', `${T}/machines/${mach('Séchoir 2').id}/incidents`, { reason: 'Résistance HS', note: 'Appel du technicien' });
  assert.equal(r.status, 201);
  const m = r.data.machines.find(x => x.name === 'Séchoir 2');
  assert.equal(m.state, 'down'); assert.equal(m.incident.reason, 'Résistance HS');
  assert.equal((await act('POST', `${T}/machines/${mach('Séchoir 2').id}/incidents`, { reason: 'Encore' })).data.code, 'ALREADY_DOWN');

  // Le lot 2 (lavage fini) ne peut pas y aller ; il va dans l'autre séchoir.
  await act('POST', `${T}/steps/${lot2.steps[0].id}/finish`);
  r = await act('POST', `${T}/lots/${lot2.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 2').id, weightKg: 18 });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'MACHINE_DOWN');
  assert.equal((await admin('GET', A + '/overview')).data.incidents.length, 1);

  r = await act('POST', `${T}/incidents/${m.incident.id}/resolve`);
  assert.equal(r.status, 200); assert.equal(r.data.machines.find(x => x.name === 'Séchoir 2').state, 'free');
  assert.equal((await act('POST', `${T}/incidents/${m.incident.id}/resolve`)).status, 409);
  r = await act('POST', `${T}/lots/${lot2.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 2').id, weightKg: 18 });
  assert.equal(r.status, 201);
  await act('POST', `${T}/steps/${r.data.lot.current.id}/finish`);
  const hist = (await admin('GET', `${A}/incidents?from=${yesterday()}&to=${parisDate(Date.now())}`)).data.incidents;
  assert.equal(hist.length, 1); assert.equal(hist[0].open, false);
});

test('remarques et qualité : relavage, problème, remarque, rattachées au collaborateur', async () => {
  assert.equal((await act('POST', `${T}/lots/${lot1.id}/notes`, { kind: 'relavage', text: ' ' })).status, 400);
  assert.equal((await act('POST', `${T}/lots/${lot1.id}/notes`, { kind: 'peinture', text: 'x' })).status, 400);
  assert.equal((await act('POST', `${T}/lots/99999/notes`, { kind: 'remarque', text: 'x' })).status, 404);
  let r = await act('POST', `${T}/lots/${lot1.id}/notes`, { kind: 'relavage', text: '3 draps à reprendre : taches de vin' });
  assert.equal(r.status, 201);
  const n = r.data.lot.notes;
  assert.equal(n.length, 1); assert.equal(n[0].kind, 'relavage'); assert.equal(n[0].who, 'Camille Martin');
  // Le texte est stocké tel quel (l'affichage l'échappe côté écran).
  r = await act('POST', `${T}/lots/${lot1.id}/notes`, { kind: 'remarque', text: '<img src=x onerror=alert(1)>' });
  assert.equal(r.data.lot.notes[1].text, '<img src=x onerror=alert(1)>');
});

test('saisie à la main (admin) : jour passé, chevauchement refusé, futur refusé, correction d\'un passage', async () => {
  const gp = types.find(t => t.label === 'Grand plat').id, y = yesterday();
  const l3 = mach('Laveuse 3');
  const make = (patch) => admin('POST', A + '/lots', { linenTypeId: gp, clients: [{ clientId: other }], weightKg: 30, machineId: l3.id, date: y, start: '08:00', end: '08:50', ...patch });

  assert.equal((await make({ end: undefined })).status, 400, 'un passage passé a une heure de fin');
  assert.equal((await make({ date: parisDate(Date.now() + 2 * 86400000), start: '08:00', end: '08:50' })).status, 400, 'pas dans le futur');
  assert.equal((await make({ end: '07:30' })).status, 400);
  assert.equal((await make({ start: '8h' })).status, 400);
  assert.equal((await make({ weightKg: 34 })).data.code, 'OVER_CAPACITY');

  let r = await make();
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const lot = r.data.lot;
  assert.equal(lot.day, y); assert.match(lot.code, new RegExp('^L-' + y.slice(5, 7) + y.slice(8, 10) + '-01$'));
  assert.equal(lot.steps[0].open, false); assert.equal(lot.steps[0].minutes, 50);

  // Chevauche (08:30–09:00) → refusé ; juste après (08:50–09:30) → accepté.
  assert.equal((await make({ start: '08:30', end: '09:00' })).data.code, 'MACHINE_BUSY');
  r = await make({ start: '08:50', end: '09:30' });
  assert.equal(r.status, 201); const lotB = r.data.lot;
  assert.match(lotB.code, /-02$/);

  // Correction : poids, puis horaires qui chevauchent le passage voisin.
  const stepId = lot.steps[0].id;
  r = await admin('PUT', `${A}/steps/${stepId}`, { weightKg: '31' });
  assert.equal(r.status, 200); assert.equal(r.data.lot.weightKg, 31);
  assert.equal((await admin('PUT', `${A}/steps/${stepId}`, { weightKg: 40 })).status, 400);
  assert.equal((await admin('PUT', `${A}/steps/${stepId}`, { date: y, start: '08:00', end: '09:10' })).data.code, 'MACHINE_BUSY');
  r = await admin('PUT', `${A}/steps/${stepId}`, { date: y, start: '07:50', end: '08:50' });
  assert.equal(r.status, 200); assert.equal(r.data.lot.steps[0].minutes, 60);

  // Le seul passage d'un lot ne se supprime pas : on annule le lot.
  assert.equal((await admin('DELETE', `${A}/steps/${lotB.steps[0].id}`)).data.code, 'LAST_STEP');
  r = await admin('POST', `${A}/lots/${lotB.id}/cancel`);
  assert.equal(r.status, 200); assert.equal(r.data.lot.status, 'annule');
  assert.equal((await admin('POST', `${A}/lots/${lotB.id}/cancel`)).status, 409);
  r = await make({ start: '08:50', end: '09:30' });   // un lot annulé libère sa machine
  assert.equal(r.status, 201, JSON.stringify(r.data));

  // Lot terminé trop vite : on le rouvre.
  await admin('POST', `${A}/lots/${lot.id}/close`);
  assert.equal((await admin('POST', `${A}/lots/${lot.id}/reopen`)).data.lot.status, 'en_cours');
  assert.equal((await admin('POST', `${A}/lots/${lot.id}/reopen`)).status, 409);
});

test('passage resté ouvert depuis la veille : refermé et signalé au lancement suivant sur la même machine', async () => {
  const gp = types.find(t => t.label === 'Grand plat').id;
  const start = new Date(Date.now() - 30 * 3600e3).toISOString();
  const lotId = Number(db.prepare(`INSERT INTO lots (code, day, linen_type_id, created_at) VALUES ('L-OLD-01', ?, ?, ?)`).run(parisDate(Date.parse(start)), gp, start).lastInsertRowid);
  db.prepare(`INSERT INTO lot_clients (lot_id, societe, weight_kg) VALUES (?, 'Ancien', 20)`).run(lotId);
  const stepId = Number(db.prepare(`INSERT INTO lot_steps (lot_id, stage, machine_id, weight_kg, started_at) VALUES (?, 'lavage', ?, 20, ?)`).run(lotId, mach('Laveuse 2').id, start).lastInsertRowid);

  const view = (await admin('GET', `${A}/lots/${lotId}`)).data.lot;
  assert.equal(view.steps[0].stale, true); assert.match(view.stageLabel, /à clôturer/);
  assert.equal(view.steps[0].progress, null);

  const r = await act('POST', T + '/lots', { linenTypeId: gp, clients: [{ clientId: hotel }], weightKg: 15, machineId: mach('Laveuse 2').id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(db.prepare('SELECT ended_at FROM lot_steps WHERE id = ?').get(stepId).ended_at, 'ancien passage refermé');
  const notes = (await admin('GET', `${A}/lots/${lotId}`)).data.lot.notes;
  assert.equal(notes.length, 1); assert.equal(notes[0].kind, 'probleme');
  await act('POST', `${T}/steps/${r.data.lot.current.id}/finish`);
  await admin('POST', `${A}/lots/${r.data.lot.id}/cancel`);
  await admin('POST', `${A}/lots/${lotId}/cancel`);
});

test('fiche lot : poids théorique de la commande liée, écart avec la pesée, coût estimé du lavage', async () => {
  const art = db.prepare('SELECT id, name, weight_g FROM articles WHERE weight_g > 0 ORDER BY weight_g DESC LIMIT 1').get();
  assert.ok(art, 'un article pesé existe dans le catalogue de départ');
  const order = Number(db.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES ('CZ-PROD-1', ?, 'Hôtel du Palais', 'C', '06', 'a', ?, 'recue')`).run(hotel, parisDate(Date.now() + 86400000)).lastInsertRowid);
  db.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty) VALUES (?,?,?,?,?,?,?)`).run(order, art.id, art.name, 'x', 'x', 1, 20);
  const theo = Math.round(20 * art.weight_g / 100) / 10;

  const choices = (await admin('GET', A + '/choices')).data.clients;
  assert.deepEqual(choices.find(c => c.id === hotel).orders.map(o => o.ticket), ['CZ-PROD-1']);
  assert.equal(choices.find(c => c.id === other).orders.length, 0);

  // Une commande d'un autre client est refusée ; la bonne est acceptée.
  let r = await admin('PUT', `${A}/lots/${lot1.id}`, { clients: [{ clientId: other, orderId: order }] });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'BAD_ORDER');
  r = await admin('PUT', `${A}/lots/${lot1.id}`, { clients: [{ clientId: hotel, orderId: order }], note: 'Lot du matin' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const lot = r.data.lot;
  assert.equal(lot.note, 'Lot du matin'); assert.equal(lot.clients[0].orderTicket, 'CZ-PROD-1');
  assert.equal(lot.content.theoreticalKg, theo);
  assert.equal(lot.content.orders[0].items[0].qty, 20);
  assert.equal(lot.content.gap.pct, Math.round((24.5 - theo) / theo * 100));
  assert.equal(lot.content.gap.withinTolerance, Math.abs(lot.content.gap.pct) <= 5);

  // Coût du lavage : eau 180 L × 4,20 €/m³ = 76 c, énergie 3,5 kWh × 0,18 = 63 c, lessive 35 c.
  assert.deepEqual([lot.cost.waterCents, lot.cost.energyCents, lot.cost.detergentCents, lot.cost.totalCents], [76, 63, 35, 174]);
  assert.equal(lot.cost.complete, true); assert.equal(lot.cost.perKgCents, 7);
  // Le lot mélangé n'a pas de programme : aucun coût estimé, jamais un zéro inventé.
  const l2 = (await admin('GET', `${A}/lots/${lot2.id}`)).data.lot;
  assert.equal(l2.cost.totalCents, 0); assert.equal(l2.cost.complete, false); assert.equal(l2.cost.perKgCents, null); assert.equal(l2.content.gap, null);
});

test('heures et tableau de bord : kilos par étape, coût de main-d\'œuvre par kilo, machines, répartition', async () => {
  const y = yesterday(), t = parisDate(Date.now());
  // 8 h pointées hier au lavage à 20 €/h = 160 €.
  const e = await admin('POST', '/api/admin/rh/entries', { employeeId: camille.id, date: y, start: '05:00', end: '13:00', machineId: mach('Laveuse 1').id });
  assert.equal(e.status, 201, JSON.stringify(e.data));

  const lots = (await admin('GET', `${A}/lots?from=${y}&to=${t}`)).data.lots.filter(l => l.status !== 'annule');
  const washKg = Math.round(lots.reduce((a, l) => a + l.weightKg, 0) * 10) / 10;
  assert.ok(washKg > 0);

  const st = (await admin('GET', `${A}/stats?from=${y}&to=${t}`)).data;
  assert.equal(st.kg.lavage, washKg);
  assert.equal(st.daily.reduce((a, d) => a + d.kgLavage, 0).toFixed(1), washKg.toFixed(1));
  assert.equal(st.lots, lots.length);
  assert.ok(st.kg.sechage > 0 && st.kg.finition === 24.5);
  const lav = st.labour.find(l => l.bu === 'lavage');
  assert.equal(lav.minutes, 480); assert.equal(lav.costCents, 16000); assert.equal(lav.kg, washKg);
  assert.equal(lav.costPerKgCents, Math.round(16000 / washKg)); assert.equal(lav.kgPerHour, Math.round(washKg / 8 * 10) / 10);
  assert.equal(st.costPerKgCents, Math.round(16000 / washKg));
  assert.equal(st.targetCentsPerKg, 130);
  assert.equal(st.consumables.washPasses, 1); assert.equal(st.consumables.completePasses, 1); assert.equal(st.consumables.waterCents, 76);
  assert.equal(st.unpricedEmployees, 0);
  assert.match(st.note, /séchoirs et des calandres/);

  const l1 = st.machines.find(m => m.name === 'Laveuse 1');
  assert.equal(l1.passes, 1); assert.equal(l1.kg, 24.5); assert.equal(l1.avgLoadPct, Math.round(24.5 / 27 * 100));
  assert.ok(l1.utilization >= 0 && l1.utilization <= 1);
  const sec2 = st.machines.find(m => m.name === 'Séchoir 2');
  assert.equal(sec2.incidents, 1); assert.ok(sec2.downMin >= 0);
  assert.equal(st.byClient.find(c => c.label === 'Hôtel du Palais').kg > 0, true);
  assert.equal(st.unassignedKg, 2, 'les 2 kg du lot mélangé non attribués à un client ressortent à part');
  assert.ok(st.byType.some(x => x.label === 'Éponge'));
  assert.equal(st.rewashes, 1); assert.equal(st.remarks, 1);

  const h = (await admin('GET', `${A}/hours?from=${y}&to=${t}`)).data;
  const hl = h.byBu.find(b => b.bu === 'lavage');
  assert.equal(hl.min, 480); assert.equal(hl.kg, washKg); assert.equal(hl.costPerKgCents, Math.round(16000 / washKg));
  const hm = h.byMachine.find(m => m.name === 'Laveuse 1');
  assert.equal(hm.min, 480); assert.equal(hm.kg, 24.5); assert.equal(hm.kgPerHour, Math.round(24.5 / 8 * 10) / 10);

  // Une journée sans activité : zéros, pas d'erreur ni de division par zéro.
  const empty = (await admin('GET', `${A}/stats?from=2020-01-06&to=2020-01-07`)).data;
  assert.equal(empty.kg.lavage, 0); assert.equal(empty.costPerKgCents, null); assert.equal(empty.machines[0].utilization, null);

  assert.equal((await admin('GET', `${A}/stats?from=2026-01-01&to=2026-12-31`)).status, 400);
  assert.equal((await admin('GET', `${A}/stats?from=2026-02-01&to=2026-01-01`)).status, 400);
  assert.equal((await admin('GET', `${A}/hours?from=x&to=y`)).status, 400);
});

test('liste des lots : filtres et recherche', async () => {
  const y = yesterday(), t = parisDate(Date.now());
  const all = (await admin('GET', `${A}/lots?from=${y}&to=${t}`)).data.lots;
  assert.ok(all.length >= 3);
  const q = (await admin('GET', `${A}/lots?from=${y}&to=${t}&q=dupont`)).data.lots;
  assert.deepEqual(q.map(l => l.id), [lot2.id]);
  const done = (await admin('GET', `${A}/lots?from=${y}&to=${t}&status=termine`)).data.lots;
  assert.ok(done.every(l => l.status === 'termine') && done.some(l => l.id === lot1.id));
  assert.equal((await admin('GET', `${A}/lots?from=${y}`)).status, 400);
  assert.equal((await admin('GET', `${A}/lots/99999`)).status, 404);
});

test('programmes et types déjà utilisés : retirés sans effacer l\'historique ; machine utilisée : retirée, pas supprimée', async () => {
  let r = await admin('DELETE', `${A}/programs/${prog.id}`);
  assert.equal(r.data.archived, true); assert.equal(r.data.programs.find(p => p.id === prog.id).active, false);
  const lot = (await admin('GET', `${A}/lots/${lot1.id}`)).data.lot;
  assert.equal(lot.steps[0].programName, 'Draps 60°', 'l\'historique garde le programme');
  assert.equal((await tablet('GET', T + '/state')).data.programs.length, 0, 'la tablette ne propose plus un programme retiré');

  const nouveau = (await admin('POST', A + '/programs', { name: 'Essai' })).data.id;
  assert.equal((await admin('DELETE', `${A}/programs/${nouveau}`)).data.archived, false);
  r = await admin('DELETE', `${A}/linen-types/${types.find(t => t.label === 'Éponge').id}`);
  assert.equal(r.data.archived, true);
  assert.equal((await tablet('GET', T + '/state')).data.linenTypes.some(t => t.label === 'Éponge'), false);

  r = await admin('DELETE', `/api/admin/rh/machines/${mach('Laveuse 1').id}`);
  assert.equal(r.status, 200); assert.equal(r.data.archived, true);
  assert.equal((await tablet('GET', T + '/state')).data.machines.length, 6);
});
