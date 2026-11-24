// Écran Atelier : API de la tablette. Même principe que la badgeuse : jeton de tablette (en-tête x-terminal-token) +
// code personnel (ou badge) du collaborateur pour chaque action. L'heure fait foi côté serveur ; rien n'est antidaté.
const express = require('express');
const db = require('../db');
const security = require('../middleware/security');
const rh = require('../utils/rh');
const rhStore = require('../utils/rhStore');
const P = require('../utils/prodStore');
const F = require('../utils/prodForecast');
const Q = require('../utils/prodQueues');
const { requireTerminal, authenticate, fail } = require('../utils/rhAuth');

const router = express.Router();
router.use(security.rateLimit({ name: 'atelier', windowMs: 10 * 60 * 1000, max: 1500, message: 'Trop de demandes. Réessayez dans quelques minutes.' }));
router.use(requireTerminal);

const R = (fn) => P.route((req, res) => {
  const e = authenticate(req, res);
  if (!e) return;
  fn(req, res, e);
});
/** Qui peut lancer une action : les collaborateurs actifs ayant un code, ceux qui sont pointés d'abord. Aucun secret n'est envoyé. */
function employees(nowMs) {
  const here = new Set(rhStore.allOpenEntries().filter(e => !rhStore.isStale(e, nowMs)).map(e => e.employee_id));
  return db.prepare('SELECT id, first_name, last_name, pin_hash FROM employees WHERE active = 1 ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE').all()
    .map(e => ({ id: e.id, firstName: e.first_name, lastName: e.last_name, hasPin: !!e.pin_hash, present: here.has(e.id) }))
    .sort((a, b) => Number(b.present) - Number(a.present));
}
const lastStepId = (lotId) => (db.prepare('SELECT id FROM lot_steps WHERE lot_id = ? ORDER BY id DESC LIMIT 1').get(lotId) || {}).id || null;
const who = (e) => ({ id: e.id, name: `${e.first_name} ${e.last_name}`.trim() });

// GET /api/atelier/state — tout l'écran : machines, files d'attente par étape, lots du jour, listes de choix.
router.get('/state', P.route((req, res) => {
  const nowMs = Date.now();
  const day = rh.parisDate(nowMs);
  const view = P.dayView(day, nowMs);
  res.json({
    now: new Date(nowMs).toISOString(), day, terminal: { id: req.terminal.id, label: req.terminal.label }, stages: P.STAGES, settings: { openFrom: P.getSettings().openFrom, openTo: P.getSettings().openTo },
    machines: P.board(nowMs), queues: Q.queues(nowMs), waiting: P.waitingLots(nowMs),
    today: { totals: view.totals, lots: view.lots.filter(l => l.status !== 'annule').map(l => ({ id: l.id, code: l.code, linenType: l.linenType, weightKg: l.weightKg, status: l.status, stageLabel: l.stageLabel, clients: l.clients.map(c => c.societe), createdAt: l.createdAt })) },
    forecast: { due: F.due(nowMs), tomorrow: F.totals(F.list(rh.addDays(day, 1))) },
    employees: employees(nowMs),
    linenTypes: P.linenTypes().filter(t => t.active), programs: P.programs().filter(p => p.active), clients: P.clientChoices(),
  });
}));

// GET /api/atelier/lots/:id — fiche d'un lot (lecture).
router.get('/lots/:id', P.route((req, res) => {
  const lot = P.lotDetail(Number(req.params.id));
  if (!lot) throw P.bad('Lot introuvable.', 'NOT_FOUND', 404);
  res.json({ lot });
}));

// POST /api/atelier/identify { employeeId, pin } ou { uid } — vérifie le code avant d'ouvrir les actions.
router.post('/identify', R((req, res, e) => { res.json({ employee: who(e) }); }));

// POST /api/atelier/lots — nouveau lot : lavage lancé maintenant sur une laveuse.
router.post('/lots', R((req, res, e) => {
  const b = req.body || {};
  const id = P.createLot({ linenTypeId: b.linenTypeId, clients: b.clients, weightKg: b.weightKg, machineId: b.machineId, programId: b.programId, note: b.note, employeeId: e.id, terminalId: req.terminal.id });
  res.status(201).json({ lot: P.lotDetail(id), stepId: lastStepId(id), machines: P.board() });
}));

// POST /api/atelier/forecasts/:id/launch — lance un lot prévu : même corps qu'un nouveau lot, ce qui manque reprend la prévision.
router.post('/forecasts/:id/launch', R((req, res, e) => {
  const b = req.body || {};
  const lotId = F.launch(Number(req.params.id), { linenTypeId: b.linenTypeId, clients: b.clients, weightKg: b.weightKg, machineId: b.machineId, programId: b.programId, note: b.note, employeeId: e.id, terminalId: req.terminal.id });
  res.status(201).json({ lot: P.lotDetail(lotId), stepId: lastStepId(lotId), machines: P.board() });
}));

// POST /api/atelier/forecasts — ajoute un lot à la file « À laver » d'aujourd'hui sans le lancer : type, clients, poids (facultatif), remarque.
router.post('/forecasts', R((req, res) => {
  const b = req.body || {};
  const id = F.create({ day: rh.parisDate(Date.now()), linenTypeId: b.linenTypeId, clients: b.clients, weightKg: b.weightKg, note: b.note });
  res.status(201).json({ forecast: F.get(id) });
}));

// POST /api/atelier/lots/:id/steps — séchage, finition ou second lavage d'un lot existant.
router.post('/lots/:id/steps', R((req, res, e) => {
  const b = req.body || {};
  const stepId = P.startStep({ lotId: Number(req.params.id), stage: b.stage, machineId: b.machineId, programId: b.programId, weightKg: b.weightKg, employeeId: e.id });
  res.status(201).json({ lot: P.lotDetail(Number(req.params.id)), stepId, machines: P.board() });
}));

// POST /api/atelier/steps/:id/finish { closeLot? } — fin du passage (et du lot si c'était la dernière étape).
router.post('/steps/:id/finish', R((req, res, e) => {
  const lotId = P.finishStep(Number(req.params.id), { closeLot: !!(req.body || {}).closeLot });
  res.json({ lot: P.lotDetail(lotId), machines: P.board(), by: who(e) });
}));

// Annuler un geste fait par erreur, dans les 5 minutes : un lancement (le premier lavage défait le lot) ou un « Terminé ».
router.post('/steps/:id/undo-start', R((req, res) => {
  const r = P.undoStart(Number(req.params.id));
  res.json({ lot: r.lotRemoved ? null : P.lotDetail(r.lotId), machines: P.board() });
}));
router.post('/steps/:id/undo-finish', R((req, res) => {
  const lotId = P.undoFinish(Number(req.params.id));
  res.json({ lot: P.lotDetail(lotId), machines: P.board() });
}));

router.post('/lots/:id/notes', R((req, res, e) => {
  const b = req.body || {};
  P.addNote(Number(req.params.id), String(b.kind || 'remarque'), b.text, e.id);
  res.status(201).json({ lot: P.lotDetail(Number(req.params.id)) });
}));

router.post('/lots/:id/close', R((req, res) => { P.closeLot(Number(req.params.id)); res.json({ lot: P.lotDetail(Number(req.params.id)), machines: P.board() }); }));

// Panne : la machine est marquée à l'arrêt jusqu'à ce que quelqu'un la remette en service.
router.post('/machines/:id/incidents', R((req, res, e) => {
  const b = req.body || {};
  P.openIncident({ machineId: Number(req.params.id), reason: b.reason, note: b.note, employeeId: e.id });
  res.status(201).json({ machines: P.board() });
}));
router.post('/incidents/:id/resolve', R((req, res) => { P.resolveIncident(Number(req.params.id)); res.json({ machines: P.board() }); }));

router.use((req, res) => fail(res, 404, 'Introuvable.'));

module.exports = router;
