// Prévision de production : cycles de l'atelier (lavage 50 min, séchoir 30 min) et chemin de chaque type de pièce
// (le plat va du lavage à la calandre SANS séchoir ; les éponges passent au séchoir).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const A = '/api/admin/atelier';
const P = A;
let s, db, M, prog, sech3;
const admin = (...a) => s.call(...a);
const mach = (name) => M.find(m => m.name === name).id;
const est = async (body) => (await admin('POST', `${A}/forecasts/estimate`, body)).data.plan;
const L1 = () => mach('Laveuse 1'), S1 = () => mach('Séchoir 1'), C1 = () => mach('Calandre 320 cm');

test.before(async () => {
  s = await startServer();
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  M = (await admin('GET', '/api/admin/rh/overview')).data.machines;
  prog = (await admin('POST', `${A}/programs`, { name: 'Blanc 60°', durationMin: 55, tempC: 60 })).data.id;
  // une sécheuse de 20 kg sans cadence : on la compte en cycles
  sech3 = (await admin('POST', '/api/admin/rh/machines', { name: 'Séchoir 3', bu: 'sechage', capacityKg: 20 })).data.machine.id;
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('réglages de départ : cycle de lavage 50 min, cycle de séchage 30 min', async () => {
  const st = (await admin('GET', `${P}/settings`)).data.settings;
  assert.equal(st.washCycleMin, 50);
  assert.equal(st.dryCycleMin, 30);
  const p = await est({ weightKg: 20, machines: { lavage: [{ machineId: L1() }] } });
  assert.deepEqual(p.cycles, { washMin: 50, dryMin: 30 });
});

test('lavage : le programme choisi donne la durée, sinon le cycle de 50 min', async () => {
  // 54 kg sur une laveuse de 27 kg : 2 passages
  let p = await est({ weightKg: 54, machines: { lavage: [{ machineId: L1() }] } });
  let l = p.stages.lavage.lines[0];
  assert.deepEqual([l.passes, l.passMin, l.minutes, l.source], [2, 50, 100, 'cycle']);
  assert.ok(!p.warnings.some(w => /programme/i.test(w)), 'plus d\'avertissement « choisissez un programme »');
  assert.equal(p.incomplete, false);
  // programme de 55 min : il l'emporte
  p = await est({ weightKg: 54, machines: { lavage: [{ machineId: L1(), programId: prog }] } });
  l = p.stages.lavage.lines[0];
  assert.deepEqual([l.passMin, l.minutes, l.source], [55, 110, 'programme']);
  // un programme sans durée retombe sur le cycle de l'atelier
  const noDur = (await admin('POST', `${A}/programs`, { name: 'Sans durée', tempC: 40 })).data.id;
  p = await est({ weightKg: 54, machines: { lavage: [{ machineId: L1(), programId: noDur }] } });
  assert.deepEqual([p.stages.lavage.lines[0].passMin, p.stages.lavage.lines[0].source], [50, 'cycle']);
});

test('séchage : sécheuse sans cadence = charges × cycle de 30 min ; la cadence de la fiche reste prioritaire', async () => {
  // 30 kg dans 20 kg : 2 cycles × 30 min
  let p = await est({ weightKg: 30, machines: { sechage: [{ machineId: sech3 }] } });
  let l = p.stages.sechage.lines[0];
  assert.deepEqual([l.passes, l.passMin, l.minutes, l.source], [2, 30, 60, 'cycle']);
  // 41 kg : 3 cycles (on arrondit au-dessus)
  p = await est({ weightKg: 41, machines: { sechage: [{ machineId: sech3 }] } });
  assert.equal(p.stages.sechage.lines[0].minutes, 90);
  // les séchoirs d'origine (18 kg) : 54 kg = 3 cycles ; deux séchoirs se partagent le lot : 27 kg chacun = 2 cycles chacun
  p = await est({ weightKg: 54, machines: { sechage: [{ machineId: S1() }, { machineId: mach('Séchoir 2') }] } });
  assert.deepEqual(p.stages.sechage.lines.map(x => [x.weightKg, x.passes, x.minutes]), [[27, 2, 60], [27, 2, 60]]);
  assert.equal(p.minutes.sechage, 60);
  // une cadence renseignée sur la machine passe avant le cycle
  await admin('PUT', `/api/admin/rh/machines/${sech3}`, { throughputKgh: 40 });
  p = await est({ weightKg: 30, machines: { sechage: [{ machineId: sech3 }] } });
  l = p.stages.sechage.lines[0];
  assert.deepEqual([l.minutes, l.source], [45, 'cadence']);
  await admin('PUT', `/api/admin/rh/machines/${sech3}`, { throughputKgh: null });
  p = await est({ weightKg: 30, machines: { sechage: [{ machineId: sech3 }] } });
  assert.equal(p.stages.sechage.lines[0].source, 'cycle', 'sans cadence, retour au cycle');
});

test('lot détaillé par type de pièce : le plat ne passe pas au séchoir, les éponges oui', async () => {
  const machines = { lavage: [{ machineId: L1() }], sechage: [{ machineId: sech3 }], finition: [{ machineId: C1() }] };
  // 20 kg de plat + 20 kg d'éponges
  const p = await est({ families: { grand_plat: 12, petit_plat: 8, eponge: 20 }, machines });
  assert.equal(p.weightKg, 40);
  assert.equal(p.stages.lavage.routedKg, 40, 'tout est lavé');
  assert.equal(p.stages.sechage.routedKg, 20, 'séchoir : les éponges seulement');
  assert.equal(p.stages.finition.routedKg, 20, 'calandre : le plat seulement');
  assert.equal(p.stages.sechage.lines[0].weightKg, 20);
  assert.equal(p.stages.finition.lines[0].weightKg, 20);
  assert.equal(p.stages.sechage.lines[0].minutes, 30, '20 kg = une charge de 20 kg = un cycle de 30 min');
  assert.equal(p.stages.finition.lines[0].minutes, Math.round(20 / 45 * 60));
  assert.equal(p.warnings.length, 0, p.warnings.join(' | '));

  // plus d'éponges que le séchoir ne porte : il fait plusieurs cycles
  const more = await est({ families: { grand_plat: 10, eponge: 45 }, machines: { sechage: [{ machineId: sech3 }] } });
  assert.deepEqual([more.stages.sechage.lines[0].weightKg, more.stages.sechage.lines[0].passes, more.minutes.sechage], [45, 3, 90]);

  // du plat seulement : rien à sécher, on le dit, et la durée de l'étape est nulle
  const plat = await est({ families: { grand_plat: 30, petit_plat: 10 }, machines });
  assert.equal(plat.stages.sechage.routedKg, 0);
  assert.equal(plat.stages.sechage.lines[0].weightKg, 0);
  assert.equal(plat.minutes.sechage, 0);
  assert.ok(plat.warnings.some(w => /Séchage/.test(w) && /directement en calandre/.test(w)), plat.warnings.join(' | '));
  assert.equal(plat.stages.finition.routedKg, 40);

  // des éponges seulement : rien en calandre
  const eponge = await est({ families: { eponge: 30 }, machines });
  assert.equal(eponge.stages.finition.routedKg, 0);
  assert.equal(eponge.minutes.finition, 0);
  assert.ok(eponge.warnings.some(w => /Finition/.test(w) && /éponges/.test(w)), eponge.warnings.join(' | '));
  assert.equal(eponge.stages.sechage.routedKg, 30);
});

test('lot sans détail par type de pièce : tout le poids passe partout, comme avant', async () => {
  const p = await est({ weightKg: 40, machines: { lavage: [{ machineId: L1() }], sechage: [{ machineId: sech3 }], finition: [{ machineId: C1() }] } });
  assert.equal(p.stages.sechage.routedKg, 40);
  assert.equal(p.stages.sechage.lines[0].weightKg, 40);
  assert.equal(p.stages.finition.lines[0].weightKg, 40);
  assert.equal(p.minutes.sechage, 60);
  assert.equal(p.warnings.length, 0, p.warnings.join(' | '));
});

test('kilos saisis à la main : comparés aux kilos de l\'étape, pas à tout le lot', async () => {
  const mk = (kg) => ({ families: { grand_plat: 30, eponge: 10 }, machines: { sechage: [{ machineId: sech3, weightKg: kg }] } });
  // 10 kg d'éponges : 10 kg saisis, tout va bien
  let p = await est(mk(10));
  assert.equal(p.warnings.length, 0, p.warnings.join(' | '));
  // 25 kg saisis alors que seuls 10 kg passent au séchoir
  p = await est(mk(25));
  assert.ok(p.warnings.some(w => /Séchage/.test(w) && /10 kg/.test(w) && /dépassent/.test(w)), p.warnings.join(' | '));
  // 4 kg saisis : 6 kg n'ont pas de machine
  p = await est(mk(4));
  assert.ok(p.warnings.some(w => /Séchage/.test(w) && /6 kg/.test(w)), p.warnings.join(' | '));
});

test('réglages : durées des cycles modifiables, contrôlées, vide = valeur d\'origine', async () => {
  const put = (b) => admin('PUT', `${P}/settings`, b);
  const r = await put({ washCycleMin: '45', dryCycleMin: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.settings.washCycleMin, r.data.settings.dryCycleMin], [45, 20]);
  // la prévision suit
  let p = await est({ weightKg: 54, machines: { lavage: [{ machineId: L1() }], sechage: [{ machineId: sech3 }] } });
  assert.equal(p.stages.lavage.lines[0].minutes, 90, '2 passages de 45 min');
  assert.equal(p.stages.sechage.lines[0].minutes, 60, '3 cycles de 20 min');
  assert.deepEqual(p.cycles, { washMin: 45, dryMin: 20 });
  // un programme garde la main sur le cycle de lavage
  p = await est({ weightKg: 54, machines: { lavage: [{ machineId: L1(), programId: prog }] } });
  assert.equal(p.stages.lavage.lines[0].minutes, 110);
  // contrôles : rien n'est enregistré si une valeur est refusée
  for (const bad of ['abc', '4', '601', '-30', 0]) assert.equal((await put({ washCycleMin: bad })).status, 400, `lavage ${bad}`);
  assert.equal((await put({ dryCycleMin: '1000' })).status, 400);
  assert.deepEqual([(await admin('GET', `${P}/settings`)).data.settings.washCycleMin, (await admin('GET', `${P}/settings`)).data.settings.dryCycleMin], [45, 20]);
  // virgule décimale : arrondie à la minute ; vide : valeurs d'origine
  assert.equal((await put({ washCycleMin: '52,4' })).data.settings.washCycleMin, 52);
  const back = await put({ washCycleMin: '', dryCycleMin: '' });
  assert.deepEqual([back.data.settings.washCycleMin, back.data.settings.dryCycleMin], [50, 30]);
  // un réglage détérioré en base n'écrase pas le calcul : valeur d'origine
  db.prepare("INSERT INTO prod_settings (key, value) VALUES ('wash_cycle_min', 'n/a') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  assert.equal((await admin('GET', `${P}/settings`)).data.settings.washCycleMin, 50);
  db.prepare("DELETE FROM prod_settings WHERE key = 'wash_cycle_min'").run();
  // les autres réglages ne bougent pas
  assert.equal((await admin('GET', `${P}/settings`)).data.settings.tolerancePct, 5);
  // l'écran du jour renvoie aussi les durées
  const ov = (await admin('GET', `${P}/overview`)).data;
  assert.equal(ov.settings.washCycleMin, 50);
});

test('prévision enregistrée : la durée tient compte du chemin des pièces', async () => {
  const hotel = Number(db.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES ('Hôtel Cycles', 'c', '0', 'a', 'x', datetime('now'))`).run().lastInsertRowid);
  const types = (await admin('GET', `${A}/overview`)).data.linenTypes;
  const day = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const r = await admin('POST', `${A}/forecasts`, {
    day, linenTypeId: types[0].id, clients: [{ clientId: hotel }], families: { grand_plat: 20, eponge: 20 },
    machines: { lavage: [{ machineId: L1() }], sechage: [{ machineId: sech3 }], finition: [{ machineId: C1() }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const plan = r.data.forecast.plan;
  // lavage : 40 kg dans 27 kg = 2 passages de 50 min ; séchage : 20 kg = 1 cycle de 30 min ; calandre : 20 kg à 45 kg/h = 27 min
  assert.deepEqual([plan.minutes.lavage, plan.minutes.sechage, plan.minutes.finition, plan.minutes.total], [100, 30, 27, 157]);
  const again = (await admin('GET', `${A}/forecast?day=${day}`)).data.forecasts.find(f => f.id === r.data.forecast.id);
  assert.equal(again.plan.minutes.total, 157);
});
