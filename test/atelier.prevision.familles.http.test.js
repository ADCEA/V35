// Prévision de production : poids réparti par type de pièce (grand plat, petit plat, éponge, divers) et plusieurs machines par étape
// pour estimer la durée du lavage, puis du séchage, puis de la finition.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const A = '/api/admin/atelier';
const parisDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
const plus = (n) => parisDate(Date.now() + n * 86400000);
let s, db, M, types, hotel, prog, sech4;
const admin = (...a) => s.call(...a);
const mach = (name) => M.find(m => m.name === name).id;
const base = (extra = {}) => ({ day: plus(1), linenTypeId: types[0].id, clients: [{ clientId: hotel }], ...extra });
const FAM = { grand_plat: 40, petit_plat: 10, eponge: 30, divers: 10 };
const full = () => ({
  lavage: [{ machineId: mach('Laveuse 1'), programId: prog }, { machineId: mach('Laveuse 2'), programId: prog }, { machineId: mach('Laveuse 3'), programId: prog }],
  sechage: [{ machineId: mach('Séchoir 1') }, { machineId: mach('Séchoir 2') }],
  finition: [{ machineId: mach('Calandre 320 cm') }, { machineId: mach('Calandre 250 cm') }],
});

test.before(async () => {
  s = await startServer();
  assert.equal((await admin('POST', '/api/admin/setup', { password: 'secret123' })).status, 201);
  db = new Database(path.join(s.DATA_DIR, 'database.sqlite'));
  M = (await admin('GET', '/api/admin/rh/overview')).data.machines;
  types = (await admin('GET', `${A}/overview`)).data.linenTypes;
  hotel = Number(db.prepare(`INSERT INTO clients (societe, contact, tel, adresse, code_hash, created_at) VALUES ('Hôtel Familles', 'c', '0', 'a', 'x', datetime('now'))`).run().lastInsertRowid);
  prog = (await admin('POST', `${A}/programs`, { name: 'Blanc 60°', durationMin: 55, tempC: 60 })).data.id;
  // cadences des sécheuses (les calandres ont déjà les leurs : 45 et 35 kg/h)
  await admin('PUT', `/api/admin/rh/machines/${mach('Séchoir 1')}`, { throughputKgh: 24 });
  await admin('PUT', `/api/admin/rh/machines/${mach('Séchoir 2')}`, { throughputKgh: 12 });
  // une sécheuse sans capacité ni cadence
  sech4 = (await admin('POST', '/api/admin/rh/machines', { name: 'Séchoir 4', bu: 'sechage' })).data.machine.id;
});
test.after(async () => { if (db) db.close(); if (s) await s.stop(); });

test('réservé à l\'administration', async () => {
  assert.equal((await fetch(`${s.BASE}${A}/forecasts/estimate`, { method: 'POST' })).status, 401);
});

test('poids par type de pièce : la somme fait le poids du lot, contrôles', async () => {
  const ok = await admin('POST', `${A}/forecasts`, base({ families: FAM }));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const f = ok.data.forecast;
  assert.equal(f.weightKg, 90, 'le poids du lot est la somme des types de pièces');
  assert.deepEqual(f.families.map(x => [x.id, x.weightKg, x.pct]), [['grand_plat', 40, 44], ['petit_plat', 10, 11], ['eponge', 30, 33], ['divers', 10, 11]]);

  assert.equal((await admin('POST', `${A}/forecasts`, base({ families: { chaussettes: 5 } }))).status, 400, 'type de pièce inconnu');
  assert.equal((await admin('POST', `${A}/forecasts`, base({ families: { eponge: -2 } }))).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts`, base({ families: [1, 2] }))).status, 400);
  assert.equal((await admin('POST', `${A}/forecasts`, base({ families: FAM, weightKg: 120 }))).status, 400, 'poids saisi différent de la somme');
  assert.equal((await admin('POST', `${A}/forecasts`, base({ families: FAM, weightKg: '90' }))).status, 201, 'poids saisi égal à la somme : accepté');
  // les zéros et vides sont ignorés
  const z = await admin('POST', `${A}/forecasts`, base({ families: { grand_plat: '12,5', petit_plat: '', eponge: 0 } }));
  assert.equal(z.data.forecast.weightKg, 12.5);
  assert.deepEqual(z.data.forecast.families.map(x => x.id), ['grand_plat', 'petit_plat', 'eponge', 'divers']);

  // modification : la répartition pilote le poids ; un poids seul qui la contredit est refusé ; on peut l'effacer
  assert.equal((await admin('PUT', `${A}/forecasts/${f.id}`, { weightKg: 50 })).status, 400);
  const u = await admin('PUT', `${A}/forecasts/${f.id}`, { families: { grand_plat: 20, eponge: 5 } });
  assert.equal(u.data.forecast.weightKg, 25);
  assert.equal(u.data.forecast.families.length, 4);
  const cleared = await admin('PUT', `${A}/forecasts/${f.id}`, { families: {}, weightKg: 30 });
  assert.equal(cleared.data.forecast.weightKg, 30);
  assert.deepEqual(cleared.data.forecast.families, []);
});

test('plusieurs machines par étape : durée du lavage, puis du séchage, puis de la finition', async () => {
  const r = await admin('POST', `${A}/forecasts/estimate`, { weightKg: 90, families: FAM, machines: full() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = r.data.plan;
  assert.equal(p.weightKg, 90);
  // lavage : 90 kg répartis au prorata des capacités (27 / 27 / 33) → 27,9 / 27,9 / 34,2 kg, 2 passages de 55 min chacun
  const l = p.stages.lavage;
  assert.deepEqual(l.lines.map(x => x.weightKg), [27.9, 27.9, 34.2]);
  assert.deepEqual(l.lines.map(x => x.passes), [2, 2, 2]);
  assert.deepEqual(l.lines.map(x => x.minutes), [110, 110, 110]);
  assert.equal(l.minutes, 110);
  assert.ok(l.lines.every(x => x.auto && x.source === 'programme'));
  // séchage : seuls les 40 kg d'éponges et de divers passent au séchoir (le plat va en calandre) ; au prorata des cadences
  // (24 / 12 kg/h) → 26,7 / 13,3 kg, environ 67 min chacune : elles finissent ensemble
  const d = p.stages.sechage;
  assert.equal(d.routedKg, 40);
  assert.deepEqual(d.lines.map(x => x.weightKg), [26.7, 13.3]);
  assert.deepEqual(d.lines.map(x => x.minutes), [67, 67]);
  assert.equal(d.minutes, 67);
  // finition : seuls les 60 kg de plat (et de divers) passent en calandre, à 45 et 35 kg/h → 33,8 / 26,2 kg, 45 min chacune
  const fi = p.stages.finition;
  assert.equal(fi.routedKg, 60);
  assert.deepEqual(fi.lines.map(x => x.weightKg), [33.8, 26.2]);
  assert.equal(fi.minutes, 45);
  assert.deepEqual([p.minutes.lavage, p.minutes.sechage, p.minutes.finition, p.minutes.total], [110, 67, 45, 222]);
  assert.equal(p.incomplete, false);
  assert.deepEqual(p.missingStages, []);
  assert.equal(p.families.length, 4);

  // moins de machines → plus long : une seule laveuse enchaîne les charges (90 kg / 27 kg = 4 passages)
  const one = (await admin('POST', `${A}/forecasts/estimate`, { weightKg: 90, machines: { lavage: [{ machineId: mach('Laveuse 1'), programId: prog }] } })).data.plan;
  assert.equal(one.stages.lavage.lines[0].passes, 4);
  assert.equal(one.minutes.lavage, 220);
  assert.deepEqual(one.missingStages, ['sechage', 'finition']);
  assert.equal(one.minutes.total, 220, 'seules les étapes prévues comptent');
  // kilos fixés à la main : le reste va aux machines automatiques
  const fixed = (await admin('POST', `${A}/forecasts/estimate`, { weightKg: 60, machines: { lavage: [{ machineId: mach('Laveuse 1'), programId: prog, weightKg: 27 }, { machineId: mach('Laveuse 3'), programId: prog }] } })).data.plan;
  assert.deepEqual(fixed.stages.lavage.lines.map(x => [x.weightKg, x.auto, x.passes]), [[27, false, 1], [33, true, 1]]);
  assert.equal(fixed.minutes.lavage, 55);
});

test('contrôles des machines prévues', async () => {
  const est = (body) => admin('POST', `${A}/forecasts/estimate`, body);
  const L1 = mach('Laveuse 1'), S1 = mach('Séchoir 1');
  assert.equal((await est({ weightKg: 50, machines: { lavage: [{ machineId: L1 }, { machineId: L1 }] } })).status, 400, 'une machine une seule fois par étape');
  assert.equal((await est({ weightKg: 50, machines: { lavage: [{ machineId: S1 }] } })).status, 400, 'un séchoir n\'est pas une laveuse');
  assert.equal((await est({ weightKg: 50, machines: { lavage: [{ machineId: 99999 }] } })).status, 400);
  assert.equal((await est({ weightKg: 50, machines: { sechage: [{ machineId: S1, programId: prog }] } })).status, 400, 'programme : lavage seulement');
  assert.equal((await est({ weightKg: 50, machines: { repassage: [] } })).status, 400, 'étape inconnue');
  assert.equal((await est({ weightKg: 50, machines: { lavage: [{ machineId: L1, programId: 99999 }] } })).status, 400);
  assert.equal((await est({ weightKg: 50, machines: { lavage: [{ machineId: L1, weightKg: 60 }] } })).status, 400, 'plus de kilos que le lot');
  assert.equal((await est({ weightKg: 50, machines: { lavage: [{ machineId: L1, weightKg: -1 }] } })).status, 400);
  assert.equal((await est({ weightKg: 50, machines: [] })).status, 400);
  assert.equal((await est({ weightKg: 50, families: { eponge: 10 } })).status, 400, 'poids ≠ somme des types');
  const many = Array.from({ length: 7 }, (_, i) => ({ machineId: M[i].id }));
  assert.equal((await est({ weightKg: 50, machines: { lavage: many } })).status, 400, 'trop de machines');
  // une machine peut avoir plus que sa capacité : elle fait plusieurs passages
  const big = await est({ weightKg: 80, machines: { lavage: [{ machineId: L1, programId: prog }] } });
  assert.equal(big.status, 200);
  assert.equal(big.data.plan.stages.lavage.lines[0].passes, 3);
  assert.equal(big.data.plan.minutes.lavage, 165);
});

test('durée inconnue ou tirée de l\'historique de la machine : on le dit', async () => {
  const est = async (body) => (await admin('POST', `${A}/forecasts/estimate`, body)).data.plan;
  // sécheuse sans capacité, sans cadence ni historique : rien à calculer
  let p = await est({ weightKg: 30, machines: { sechage: [{ machineId: sech4 }] } });
  assert.equal(p.stages.sechage.lines[0].minutes, null);
  assert.equal(p.incomplete, true);
  assert.equal(p.minutes.total, 0);
  assert.ok(p.warnings.some(w => /Séchoir 4/.test(w) && /cadence/i.test(w)), p.warnings.join(' | '));
  // laveuse sans programme : le cycle de lavage de l'atelier (50 min) sert, sans avertissement
  p = await est({ weightKg: 20, machines: { lavage: [{ machineId: mach('Laveuse 2') }] } });
  assert.equal(p.stages.lavage.lines[0].minutes, 50);
  assert.equal(p.stages.lavage.lines[0].source, 'cycle');
  assert.ok(!p.warnings.some(w => /programme/i.test(w)), p.warnings.join(' | '));
  // poids du lot inconnu : répartition automatique impossible
  p = await est({ machines: { lavage: [{ machineId: mach('Laveuse 2'), programId: prog }] } });
  assert.equal(p.stages.lavage.lines[0].weightKg, null);
  assert.ok(p.warnings.some(w => /poids du lot/i.test(w)));

  // 3 passages terminés de la sécheuse (15 kg en 60 min) : cadence médiane 15 kg/h
  const lot = Number(db.prepare(`INSERT INTO lots (code, day, status, created_at) VALUES ('T-HIST', ?, 'termine', datetime('now'))`).run(plus(-3)).lastInsertRowid);
  for (let i = 0; i < 3; i += 1) {
    const start = Date.now() - (3 + i) * 3600e3 * 24;
    db.prepare(`INSERT INTO lot_steps (lot_id, stage, machine_id, weight_kg, started_at, ended_at) VALUES (?, 'sechage', ?, 15, ?, ?)`).run(lot, sech4, new Date(start).toISOString(), new Date(start + 3600e3).toISOString());
  }
  p = await est({ weightKg: 30, machines: { sechage: [{ machineId: sech4 }] } });
  assert.equal(p.stages.sechage.lines[0].minutes, 120);
  assert.equal(p.stages.sechage.lines[0].source, 'historique');
  assert.equal(p.incomplete, false);
});

test('enregistrement, modification, ancienne laveuse prévue, recopie', async () => {
  const day = plus(2);
  const r = await admin('POST', `${A}/forecasts`, base({ day, families: FAM, machines: full() }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const f = r.data.forecast;
  assert.equal(f.machineName, 'Laveuse 1', 'la première laveuse prévue reste la laveuse du lot');
  assert.equal(f.machines.length, 7);
  assert.equal(f.plan.minutes.total, 222);
  // lu dans l'écran du jour
  const day1 = (await admin('GET', `${A}/forecast?day=${day}`)).data.forecasts.find(x => x.id === f.id);
  assert.equal(day1.plan.minutes.total, 222);
  assert.equal(day1.plan.stages.sechage.lines.length, 2);

  // changer les machines remplace toutes les lignes ; le poids reste
  const u = await admin('PUT', `${A}/forecasts/${f.id}`, { machines: { lavage: [{ machineId: mach('Laveuse 3'), programId: prog }] } });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal(u.data.forecast.machines.length, 1);
  assert.equal(u.data.forecast.machineName, 'Laveuse 3');
  assert.equal(u.data.forecast.weightKg, 90);
  assert.equal(u.data.forecast.plan.stages.lavage.lines[0].passes, 3);
  // machines vides : plus rien de prévu
  const none = await admin('PUT', `${A}/forecasts/${f.id}`, { machines: {} });
  assert.equal(none.data.forecast.machineId, null);
  assert.equal(none.data.forecast.plan.minutes.total, null);

  // ancienne saisie (une laveuse + programme) : devient une ligne de lavage ; la capacité (27 kg) n'est qu'un repère, 30 kg sont acceptés
  assert.equal((await admin('PUT', `${A}/forecasts/${f.id}`, { families: {}, weightKg: 30, machineId: mach('Laveuse 1') })).status, 200);
  const old = await admin('PUT', `${A}/forecasts/${f.id}`, { families: {}, weightKg: 24, machineId: mach('Laveuse 1'), programId: prog });
  assert.equal(old.status, 200, JSON.stringify(old.data));
  assert.equal(old.data.forecast.plan.minutes.lavage, 55);
  assert.equal(old.data.forecast.machines.length, 1);

  // recopie : types de pièces et machines suivent
  const g = await admin('POST', `${A}/forecasts`, base({ day, families: FAM, machines: full() }));
  const cp = await admin('POST', `${A}/forecasts/copy`, { from: day, to: plus(5) });
  assert.equal(cp.status, 201);
  const copied = (await admin('GET', `${A}/forecast?day=${plus(5)}`)).data.forecasts;
  assert.equal(copied.length, 2);
  const withFam = copied.find(x => x.families.length);
  assert.equal(withFam.weightKg, 90);
  assert.equal(withFam.plan.minutes.total, 222);
  assert.ok(g.data.forecast.id);

  // supprimer la prévision supprime ses lignes
  assert.equal((await admin('DELETE', `${A}/forecasts/${f.id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lot_forecast_machines WHERE forecast_id = ?').get(f.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lot_forecast_families WHERE forecast_id = ?').get(f.id).n, 0);
});

test('lancer un lot prévu sur plusieurs laveuses : la part de la première laveuse part, le reste attend dans la file', async () => {
  const r = await admin('POST', `${A}/forecasts`, base({
    day: plus(0), families: { grand_plat: 50, eponge: 30 }, clients: [{ clientId: hotel, weightKg: 60 }],
    machines: { lavage: [{ machineId: mach('Laveuse 2'), programId: prog }, { machineId: mach('Laveuse 3'), programId: prog }] },
  }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const f = r.data.forecast;
  // 80 kg au prorata 27 / 33 → 36 kg et 44 kg ; la première laveuse prend sa part (36 kg, sa capacité de 27 kg n'est pas un plafond)
  assert.deepEqual(f.plan.stages.lavage.lines.map(x => x.weightKg), [36, 44]);
  assert.deepEqual(f.firstPass, { machineId: mach('Laveuse 2'), programId: prog, weightKg: 36, others: ['Laveuse 3'] });
  const launched = await admin('POST', `${A}/forecasts/${f.id}/launch`, {});
  assert.equal(launched.status, 201, JSON.stringify(launched.data));
  const lot = launched.data.lot;
  assert.equal(lot.steps.length, 1);
  assert.equal(lot.steps[0].machineName, 'Laveuse 2');
  assert.equal(lot.steps[0].weightKg, 36);
  assert.equal(lot.clients[0].weightKg, 27, 'les kilos du client suivent la part lancée (60 kg × 36 / 80)');
  // le reste de la prévision (44 kg) reste à lancer : poids, types de pièces et kilos du client suivent
  const after = (await admin('GET', `${A}/forecast?day=${plus(0)}`)).data.forecasts.find(x => x.id === f.id);
  assert.equal(after.status, 'prevu');
  assert.equal(after.weightKg, 44);
  assert.deepEqual(after.families.filter(x => x.weightKg > 0).map(x => [x.id, x.weightKg]), [['grand_plat', 27.5], ['eponge', 16.5]]);
  assert.equal(after.clients[0].weightKg, 33);
  assert.equal(after.lotCode, null);
});
