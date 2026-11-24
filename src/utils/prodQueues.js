// Files d'attente de l'atelier : une par étape (À laver, À sécher, À finir). Elles se déduisent des lots et des prévisions, rien n'est saisi à part :
//   - À laver : les prévisions arrivées à leur jour (kilos restant à laver) ;
//   - À sécher / À finir : les kilos d'un lot dont l'étape d'avant est terminée et qui n'ont pas encore été mis en machine, selon le parcours de
//     son type de linge (le plat va du lavage à la calandre, l'éponge au séchoir, le reste partout). Quand un passage se termine, le lot arrive
//     donc tout seul dans la file suivante ; quand le dernier se termine, le lot se clôt.
// Aucune capacité ne limite ce qu'on met dans une machine : un lot se lance en entier ou en partie, le reste reste dans la file.
const rh = require('./rh');
const P = require('./prodStore');
const F = require('./prodForecast');

const ORDER = ['lavage', 'sechage', 'finition'];

function queues(nowMs = Date.now()) {
  const out = { lavage: [], sechage: [], finition: [] };
  for (const f of F.due(nowMs)) {
    out.lavage.push({
      kind: 'forecast', id: f.id, code: null, stage: 'lavage', linenType: f.linenType, weightKg: f.weightKg, clients: f.clients.map(c => c.societe), planned: true,
      day: f.day, note: f.note, programId: f.firstPass ? f.firstPass.programId : f.programId, machineId: f.firstPass ? f.firstPass.machineId : f.machineId,
    });
  }
  const since = rh.parisDate(nowMs - 3 * 86400000);
  const rows = [];
  for (const l of P.loadLots("l.status = 'en_cours' AND l.day >= ?", [since], nowMs)) {
    for (const p of P.pendingStages(l)) {
      if (p.kg <= 0.04) continue;
      rows.push({ kind: 'lot', id: l.id, code: l.code, stage: p.stage, linenType: l.linenType, weightKg: p.kg, totalKg: l.weightKg, clients: l.clients.map(c => c.societe), planned: false, since: p.since });
    }
  }
  rows.sort((a, b) => String(a.since).localeCompare(String(b.since)));   // le plus ancien d'abord
  for (const r of rows) out[r.stage].push(r);
  return out;
}

module.exports = { ORDER, queues };
