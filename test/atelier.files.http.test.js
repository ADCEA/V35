// Atelier : files d'attente par étape (À laver, À sécher, À finir) et aucune limite de capacité.
// Un lot passe tout seul d'une file à l'autre selon son type de linge ; le dernier « Terminé » le clôt ; les gestes faits par erreur s'annulent.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const A = '/api/admin/atelier';
const T = '/api/atelier';
const parisDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const today = () => parisDate(Date.now());
let s, db, M, types, hotel, token, camille;
const admin = (...a) => s.call(...a);
const mach = (name) => M.find(m => m.name === name).id;
const type = (label) => types.find(t => t.label === label).id;
async function tablet(method, url, body, tok = token) {
  const res = await fetch(s.BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { 'x-terminal-token': tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const who = () => ({ employeeId: camille.id, pin: '4827' });
const act = (method, url, body) => tablet(method, url, { ...who(), ...(body || {}) });
const state = async () => (await tablet('GET', `${T}/state`)).data;
const queue = async (stage) => (await state()).queues[stage];
const lotRow = (id) => db.prepare('SELECT * FROM lots WHERE id = ?').get(id);

test.before(async () => {
  s = await startServer();
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  M = (await admin('GET', '/api/admin/rh/overview')).data.machines;
  types = (await admin('GET', `${A}/overview`)).data.linenTypes;
  hotel = Number(db.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES ('Hôtel des Files', 'c', '0', 'a', 'x', datetime('now'))`).run().lastInsertRowid);
  camille = (await admin('POST', '/api/admin/rh/employees', { firstName: 'Camille', lastName: 'Martin', contract: 'cdi', machineId: mach('Laveuse 1'), pin: '4827', hourlyCost: '20' })).data.employee;
  token = (await admin('POST', '/api/admin/rh/terminals', { label: 'Atelier' })).data.token;
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('la capacité n\'est qu\'un repère : 40 kg dans une laveuse de 27 kg, puis dans un séchoir de 18 kg', async () => {
  const r = await act('POST', `${T}/lots`, { linenTypeId: type('Éponge'), clients: [{ clientId: hotel }], weightKg: 40, machineId: mach('Laveuse 1') });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.lot.weightKg, 40);
  assert.ok(r.data.stepId, 'le lancement renvoie le passage (pour pouvoir l\'annuler)');
  // sans programme : la fin prévue est le cycle de lavage des Réglages (50 min), même au-delà de la capacité
  const st = r.data.lot.steps[0];
  assert.equal(Math.round((Date.parse(st.plannedEndAt) - Date.parse(st.startedAt)) / 60000), 50);
  assert.equal((await act('POST', `${T}/steps/${r.data.stepId}/finish`)).status, 200);
  const dry = await act('POST', `${T}/lots/${r.data.lot.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 1'), weightKg: 40 });
  assert.equal(dry.status, 201, JSON.stringify(dry.data));
  const d = dry.data.lot.current;
  // séchoir sans cadence : un cycle de séchage (30 min) par charge de son poids repère (18 kg) → 3 charges
  assert.equal(Math.round((Date.parse(d.plannedEndAt) - Date.parse(d.startedAt)) / 60000), 90);
  assert.equal((await act('POST', `${T}/steps/${dry.data.stepId}/finish`)).status, 200);
});

test('files d\'attente : une prévue arrive dans À laver, le lot suit son parcours (plat : lavage → calandre ; éponge : lavage → séchoir) et se clôt à la fin', async () => {
  // état de départ : le lot « éponge » du test précédent est déjà terminé (lavage + séchage = tout son parcours)
  const before = await state();
  assert.deepEqual(before.queues, { lavage: [], sechage: [], finition: [] });
  assert.equal(before.today.lots.find(l => l.weightKg === 40).status, 'termine', 'éponge lavée puis séchée : le lot se clôt tout seul');

  // une prévision du jour apparaît dans « À laver »
  const mk = await admin('POST', `${A}/forecasts`, { day: today(), linenTypeId: type('Grand plat'), weightKg: 90, clients: [{ clientId: hotel }], note: 'Draps du matin' });
  assert.equal(mk.status, 201);
  const fid = mk.data.forecast.id;
  let q = await queue('lavage');
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].kind, q[0].id, q[0].linenType, q[0].weightKg, q[0].planned, q[0].clients], ['forecast', fid, 'Grand plat', 90, true, ['Hôtel des Files']]);

  // on lance 90 kg d'un coup dans une laveuse de 27 kg
  const go = await act('POST', `${T}/forecasts/${fid}/launch`, { machineId: mach('Laveuse 2'), weightKg: 90 });
  assert.equal(go.status, 201, JSON.stringify(go.data));
  const lot = go.data.lot;
  assert.equal(lot.weightKg, 90);
  assert.deepEqual((await state()).queues, { lavage: [], sechage: [], finition: [] });

  // fin du lavage : le plat va directement en file « À finir » (pas de séchoir), avec ses 90 kg
  assert.equal((await act('POST', `${T}/steps/${go.data.stepId}/finish`)).status, 200);
  let st = await state();
  assert.deepEqual(st.queues.sechage, []);
  assert.deepEqual(st.queues.finition.map(x => [x.kind, x.id, x.code, x.weightKg, x.totalKg]), [['lot', lot.id, lot.code, 90, 90]]);

  // lancement partiel : 60 kg sur la calandre 320 (45 kg/h) ; le reste (30 kg) attend dans la file
  const part = await act('POST', `${T}/lots/${lot.id}/steps`, { stage: 'finition', machineId: mach('Calandre 320 cm'), weightKg: 60 });
  assert.equal(part.status, 201, JSON.stringify(part.data));
  const f1 = part.data.lot.current;
  assert.equal(Math.round((Date.parse(f1.plannedEndAt) - Date.parse(f1.startedAt)) / 60000), 80, '60 kg ÷ 45 kg/h = 80 min : la cadence fixe l\'heure de fin');
  assert.deepEqual((await queue('finition')).map(x => x.weightKg), [30]);

  // le reste part sur la 250 ; la file se vide, le lot n'est pas fini tant que ça tourne
  const rest = await act('POST', `${T}/lots/${lot.id}/steps`, { stage: 'finition', machineId: mach('Calandre 250 cm'), weightKg: 30 });
  assert.equal(rest.status, 201);
  assert.deepEqual((await queue('finition')), []);
  let fin = await act('POST', `${T}/steps/${part.data.stepId}/finish`);
  assert.equal(fin.data.lot.status, 'en_cours', 'une calandre tourne encore');
  fin = await act('POST', `${T}/steps/${rest.data.stepId}/finish`);
  assert.equal(fin.data.lot.status, 'termine', 'dernier passage terminé : le lot est clos tout seul');
  assert.equal(fin.data.lot.stageLabel, 'Terminé');
  assert.deepEqual((await state()).queues, { lavage: [], sechage: [], finition: [] });
});

test('lot « divers » : il traverse les trois files ; l\'ordre d\'arrivée fait l\'ordre de la file', async () => {
  const mkLot = async (label, kg, machine) => (await act('POST', `${T}/lots`, { linenTypeId: type(label), clients: [{ societe: 'Divers ' + label }], weightKg: kg, machineId: mach(machine) })).data;
  const a = await mkLot('Tenues', 12, 'Laveuse 1');
  const b = await mkLot('Tenues', 20, 'Laveuse 3');
  await act('POST', `${T}/steps/${b.stepId}/finish`);
  await new Promise(r => setTimeout(r, 30));
  await act('POST', `${T}/steps/${a.stepId}/finish`);
  assert.deepEqual((await queue('sechage')).map(x => x.code), [b.lot.code, a.lot.code], 'le premier lavé est le premier de la file');
  assert.deepEqual(await queue('finition'), []);

  const dryB = await act('POST', `${T}/lots/${b.lot.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 2'), weightKg: 20 });
  assert.equal(dryB.status, 201);
  await act('POST', `${T}/steps/${dryB.data.stepId}/finish`);
  assert.deepEqual((await queue('finition')).map(x => x.code), [b.lot.code]);
  assert.deepEqual((await queue('sechage')).map(x => x.code), [a.lot.code]);
  assert.equal(lotRow(b.lot.id).status, 'en_cours', 'il reste la finition');
});

test('annuler « Terminé » : le passage repart, le lot se rouvre ; pas si la machine a déjà repris autre chose', async () => {
  const mk = (await act('POST', `${T}/lots`, { linenTypeId: type('Spa'), clients: [{ societe: 'Spa du Lac' }], weightKg: 15, machineId: mach('Laveuse 2') })).data;
  await act('POST', `${T}/steps/${mk.stepId}/finish`);
  const dry = await act('POST', `${T}/lots/${mk.lot.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 1'), weightKg: 15 });
  const fin = await act('POST', `${T}/steps/${dry.data.stepId}/finish`);
  assert.equal(fin.data.lot.status, 'termine');

  // sans code : refusé
  assert.equal((await tablet('POST', `${T}/steps/${dry.data.stepId}/undo-finish`, {})).status, 401);
  const undo = await act('POST', `${T}/steps/${dry.data.stepId}/undo-finish`);
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
  assert.equal(undo.data.lot.status, 'en_cours');
  assert.equal(undo.data.lot.current.machineName, 'Séchoir 1');
  assert.equal(undo.data.machines.find(m => m.name === 'Séchoir 1').state, 'running');
  assert.equal((await act('POST', `${T}/steps/${dry.data.stepId}/undo-finish`)).data.code, 'NOT_DONE');

  // terminé de nouveau, la machine repart sur un autre lot : on ne peut plus rouvrir l'ancien passage
  await act('POST', `${T}/steps/${dry.data.stepId}/finish`);
  const other = (await act('POST', `${T}/lots`, { linenTypeId: type('Éponge'), clients: [{ societe: 'Autre' }], weightKg: 8, machineId: mach('Laveuse 3') })).data;
  await act('POST', `${T}/steps/${other.stepId}/finish`);
  const dry2 = await act('POST', `${T}/lots/${other.lot.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 1'), weightKg: 8 });
  assert.equal(dry2.status, 201);
  const late = await act('POST', `${T}/steps/${dry.data.stepId}/undo-finish`);
  assert.equal(late.status, 409); assert.equal(late.data.code, 'MACHINE_BUSY');
  // trop tard : passé 5 minutes, on passe par l'administration
  db.prepare("UPDATE lot_steps SET ended_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 60000).toISOString(), dry.data.stepId);
  assert.equal((await act('POST', `${T}/steps/${dry.data.stepId}/undo-finish`)).data.code, 'TOO_LATE');
  await act('POST', `${T}/steps/${dry2.data.stepId}/finish`);
});

test('annuler un lancement : le premier lavage défait le lot et rend ses kilos à la prévision ; un séchage lancé se retire seul', async () => {
  // lancement entier d'une prévision
  const f = (await admin('POST', `${A}/forecasts`, { day: today(), linenTypeId: type('Petit plat'), weightKg: 50, clients: [{ clientId: hotel }] })).data.forecast;
  const go = await act('POST', `${T}/forecasts/${f.id}/launch`, { machineId: mach('Laveuse 1'), weightKg: 50 });
  assert.equal(go.status, 201);
  assert.equal(db.prepare('SELECT status FROM lot_forecasts WHERE id = ?').get(f.id).status, 'lance');
  assert.equal((await tablet('POST', `${T}/steps/${go.data.stepId}/undo-start`, {})).status, 401);
  const un = await act('POST', `${T}/steps/${go.data.stepId}/undo-start`);
  assert.equal(un.status, 200, JSON.stringify(un.data));
  assert.equal(un.data.lot, null, 'le lot n\'a jamais existé');
  assert.equal(lotRow(go.data.lot.id), undefined);
  assert.equal(db.prepare('SELECT status, lot_id FROM lot_forecasts WHERE id = ?').get(f.id).status, 'prevu');
  assert.deepEqual((await queue('lavage')).map(x => [x.id, x.weightKg]), [[f.id, 50]], 'la prévision est de nouveau dans la file');
  assert.equal(un.data.machines.find(m => m.name === 'Laveuse 1').state, 'free');

  // lancement partiel (20 kg sur 50) puis annulation : les 20 kg reviennent
  const part = await act('POST', `${T}/forecasts/${f.id}/launch`, { machineId: mach('Laveuse 1'), weightKg: 20 });
  assert.equal(part.status, 201);
  assert.deepEqual((await queue('lavage')).map(x => x.weightKg), [30]);
  assert.equal((await act('POST', `${T}/steps/${part.data.stepId}/undo-start`)).status, 200);
  assert.deepEqual((await queue('lavage')).map(x => [x.id, x.weightKg]), [[f.id, 50]]);

  // un séchage lancé par erreur : le passage disparaît, le lot reste et revient dans la file
  const lot = (await act('POST', `${T}/lots`, { linenTypeId: type('Éponge'), clients: [{ societe: 'Sèche' }], weightKg: 10, machineId: mach('Laveuse 2') })).data;
  await act('POST', `${T}/steps/${lot.stepId}/finish`);
  const dry = await act('POST', `${T}/lots/${lot.lot.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 2'), weightKg: 10 });
  const mine = async () => (await queue('sechage')).filter(x => x.id === lot.lot.id);   // la file contient aussi le lot « divers » du test précédent
  assert.deepEqual(await mine(), []);
  const back = await act('POST', `${T}/steps/${dry.data.stepId}/undo-start`);
  assert.equal(back.status, 200);
  assert.equal(back.data.lot.steps.length, 1);
  assert.deepEqual((await mine()).map(x => [x.id, x.weightKg]), [[lot.lot.id, 10]]);
  // un passage déjà terminé ne s'annule pas comme un lancement
  assert.equal((await act('POST', `${T}/steps/${lot.stepId}/undo-start`)).data.code, 'ALREADY_DONE');
});

test('l\'administration voit les mêmes files', async () => {
  const q = (await admin('GET', `${A}/overview`)).data.queues;
  assert.ok(q && Array.isArray(q.lavage) && Array.isArray(q.sechage) && Array.isArray(q.finition));
  assert.ok(q.sechage.some(x => x.kind === 'lot'), 'le lot éponge laissé en attente de séchage');
});

test('la machine en marche annonce la suite : file suivante selon le type de linge, ou « lot terminé »', async () => {
  const stepOf = async (machine) => (await state()).machines.find(m => m.name === machine).step;
  // éponge : lavage → séchage
  const e = (await act('POST', `${T}/lots`, { linenTypeId: type('Éponge'), clients: [{ clientId: hotel }], weightKg: 12, machineId: mach('Laveuse 3') })).data;
  let st = await stepOf('Laveuse 3');
  assert.deepEqual([st.nextStage, st.lastOfRoute], ['sechage', false]);
  await act('POST', `${T}/steps/${e.stepId}/finish`);
  const dry = await act('POST', `${T}/lots/${e.lot.id}/steps`, { stage: 'sechage', machineId: mach('Séchoir 1'), weightKg: 12 });
  st = await stepOf('Séchoir 1');
  assert.deepEqual([st.nextStage, st.lastOfRoute], [null, true], 'le séchage est la dernière étape de l\'éponge : le lot se clôt à la fin');
  await act('POST', `${T}/steps/${dry.data.stepId}/finish`);

  // plat : lavage → finition (pas de séchoir)
  const p = (await act('POST', `${T}/lots`, { linenTypeId: type('Grand plat'), clients: [{ clientId: hotel }], weightKg: 12, machineId: mach('Laveuse 3') })).data;
  st = await stepOf('Laveuse 3');
  assert.deepEqual([st.nextStage, st.lastOfRoute], ['finition', false]);
  await act('POST', `${T}/steps/${p.stepId}/finish`);
  const fin = await act('POST', `${T}/lots/${p.lot.id}/steps`, { stage: 'finition', machineId: mach('Calandre 250 cm'), weightKg: 12 });
  st = await stepOf('Calandre 250 cm');
  assert.deepEqual([st.nextStage, st.lastOfRoute], [null, true]);
  await act('POST', `${T}/steps/${fin.data.stepId}/finish`);
});

test('la tablette peut ajouter un lot à la file « À laver » sans le lancer (identification requise)', async () => {
  const before = (await queue('lavage')).length;
  const body = { linenTypeId: type('Grand plat'), clients: [{ clientId: hotel }], weightKg: 33, note: 'Ajouté à la main' };
  // sans identification : refusé
  const no = await tablet('POST', `${T}/forecasts`, body);
  assert.equal(no.status, 401);
  assert.equal((await queue('lavage')).length, before);
  // identifié : la prévision du jour arrive en bout de file
  const r = await act('POST', `${T}/forecasts`, body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.forecast.day, today());
  const q = await queue('lavage');
  assert.equal(q.length, before + 1);
  const mine = q[q.length - 1];
  assert.deepEqual([mine.kind, mine.id, mine.linenType, mine.weightKg, mine.note, mine.clients], ['forecast', r.data.forecast.id, 'Grand plat', 33, 'Ajouté à la main', ['Hôtel des Files']]);
  // données invalides : type de linge manquant
  const bad = await act('POST', `${T}/forecasts`, { clients: [{ clientId: hotel }], weightKg: 5 });
  assert.equal(bad.status, 400);
  // on peut le lancer ensuite comme n'importe quelle prévue
  const go = await act('POST', `${T}/forecasts/${mine.id}/launch`, { machineId: mach('Laveuse 3'), weightKg: 33 });
  assert.equal(go.status, 201, JSON.stringify(go.data));
  assert.equal((await queue('lavage')).length, before);
  await act('POST', `${T}/steps/${go.data.stepId}/undo-start`);   // on remet les files comme on les a trouvées
});

test('les réglages montrent le parcours de chaque type de linge', async () => {
  const t = (await admin('GET', `${A}/overview`)).data.linenTypes;
  const route = (label) => t.find(x => x.label === label).route;
  assert.deepEqual(route('Grand plat'), ['lavage', 'finition']);
  assert.deepEqual(route('Éponge'), ['lavage', 'sechage']);
  assert.deepEqual(route('Tenues'), ['lavage', 'sechage', 'finition']);
});
