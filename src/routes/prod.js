// Administration Production : lots de lavage, passages machine, incidents, programmes, types de linge, réglages, heures et tableau de bord.
// Réservé à l'administrateur. La tablette de l'atelier utilise routes/atelier.js, qui s'appuie sur la même logique (utils/prodStore.js).
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const rh = require('../utils/rh');
const P = require('../utils/prodStore');

const router = express.Router();
router.use(requireAdmin);
const R = P.route;

/** Heure de début / fin saisies à la main (jour + HH:MM, heure de Paris) ; sans jour ni heure, on part de maintenant. */
function readTimes(b, nowMs, { keepEnd } = {}) {
  const out = {};
  if (b.date !== undefined || b.start !== undefined) {
    if (!rh.isDate(String(b.date || ''))) throw P.bad('Date invalide.');
    if (!rh.isHhmm(b.start)) throw P.bad('Heure de début invalide (format HH:MM).');
    out.startMs = rh.parisLocalMs(b.date, b.start);
    if (b.end !== undefined) {
      if (b.end === '' || b.end === null) out.endMs = null;
      else if (!rh.isHhmm(b.end)) throw P.bad('Heure de fin invalide (format HH:MM).');
      else out.endMs = rh.parisLocalMs(b.date, b.end);
    } else if (!keepEnd) out.endMs = null;
    // Un passage sans heure de fin ne peut être « en cours » qu'aujourd'hui.
    if (out.endMs === null && b.date !== rh.parisDate(nowMs)) throw P.bad('Indiquez l\'heure de fin (seul un passage d\'aujourd\'hui peut rester en cours).');
  }
  return out;
}

// GET /api/admin/prod/overview?day=YYYY-MM-DD — l'atelier à l'instant : machines, lots en attente, lots du jour.
router.get('/overview', R((req, res) => {
  const nowMs = Date.now();
  const day = req.query.day ? String(req.query.day) : rh.parisDate(nowMs);
  if (!rh.isDate(day)) throw P.bad('Jour invalide.');
  res.json({
    now: new Date(nowMs).toISOString(), today: rh.parisDate(nowMs), day, settings: P.getSettings(), stages: P.STAGES,
    machines: P.board(nowMs), waiting: P.waitingLots(nowMs), view: P.dayView(day, nowMs),
    linenTypes: P.linenTypes(), programs: P.programs(),
    incidents: db.prepare('SELECT i.*, m.name AS machine_name FROM machine_incidents i JOIN machines m ON m.id = i.machine_id WHERE i.ended_at IS NULL ORDER BY i.started_at').all().map(i => P.incidentOut(i, nowMs)),
  });
}));

// Clients et commandes à traiter, pour le formulaire d'un lot.
router.get('/choices', R((req, res) => { res.json({ clients: P.clientChoices() }); }));

// ---------- lots ----------
router.get('/lots', R((req, res) => {
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!rh.isDate(from) || !rh.isDate(to)) throw P.bad('Période invalide.');
  if (to < from) throw P.bad('La fin de période précède le début.');
  if ((Date.parse(to) - Date.parse(from)) / rh.DAY > 92) throw P.bad('Période trop longue (92 jours au plus).');
  const status = String(req.query.status || '');
  let lots = P.loadLots('l.day >= ? AND l.day <= ?', [from, to], Date.now());
  if (['en_cours', 'termine', 'annule'].includes(status)) lots = lots.filter(l => l.status === status);
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) lots = lots.filter(l => `${l.code} ${l.linenType || ''} ${l.clients.map(c => c.societe).join(' ')}`.toLowerCase().includes(q));
  res.json({ from, to, lots: lots.slice(0, 500), truncated: lots.length > 500 });
}));

router.get('/lots/:id', R((req, res) => {
  const lot = P.lotDetail(Number(req.params.id));
  if (!lot) throw P.bad('Lot introuvable.', 'NOT_FOUND', 404);
  res.json({ lot });
}));

router.post('/lots', R((req, res) => {
  const b = req.body || {}, nowMs = Date.now();
  const t = readTimes(b, nowMs);
  const id = P.createLot({ linenTypeId: b.linenTypeId, clients: b.clients, weightKg: b.weightKg, machineId: b.machineId, programId: b.programId, note: b.note, ...t, nowMs });
  res.status(201).json({ lot: P.lotDetail(id) });
}));

router.put('/lots/:id', R((req, res) => {
  P.updateLot(Number(req.params.id), req.body || {});
  res.json({ lot: P.lotDetail(Number(req.params.id)) });
}));

router.post('/lots/:id/steps', R((req, res) => {
  const b = req.body || {}, nowMs = Date.now();
  const t = readTimes(b, nowMs);
  P.startStep({ lotId: Number(req.params.id), stage: b.stage, machineId: b.machineId, programId: b.programId, weightKg: b.weightKg, note: b.note, ...t, nowMs });
  res.status(201).json({ lot: P.lotDetail(Number(req.params.id)) });
}));

router.post('/lots/:id/notes', R((req, res) => {
  const b = req.body || {};
  P.addNote(Number(req.params.id), String(b.kind || 'remarque'), b.text, null);
  res.status(201).json({ lot: P.lotDetail(Number(req.params.id)) });
}));

router.post('/lots/:id/close', R((req, res) => { P.closeLot(Number(req.params.id)); res.json({ lot: P.lotDetail(Number(req.params.id)) }); }));
router.post('/lots/:id/reopen', R((req, res) => { P.reopenLot(Number(req.params.id)); res.json({ lot: P.lotDetail(Number(req.params.id)) }); }));
router.post('/lots/:id/cancel', R((req, res) => { P.cancelLot(Number(req.params.id)); res.json({ lot: P.lotDetail(Number(req.params.id)) }); }));

// ---------- passages ----------
router.post('/steps/:id/finish', R((req, res) => {
  const lotId = P.finishStep(Number(req.params.id), { closeLot: !!(req.body || {}).closeLot });
  res.json({ lot: P.lotDetail(lotId) });
}));

router.put('/steps/:id', R((req, res) => {
  const b = req.body || {}, nowMs = Date.now();
  const t = readTimes(b, nowMs, { keepEnd: true });
  const o = { ...t, nowMs };
  for (const k of ['weightKg', 'machineId', 'programId', 'note']) if (b[k] !== undefined) o[k] = b[k];
  const lotId = P.editStep(Number(req.params.id), o, nowMs);
  res.json({ lot: P.lotDetail(lotId) });
}));

router.delete('/steps/:id', R((req, res) => { const lotId = P.deleteStep(Number(req.params.id)); res.json({ lot: P.lotDetail(lotId) }); }));

// ---------- incidents ----------
router.get('/incidents', R((req, res) => {
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!rh.isDate(from) || !rh.isDate(to) || to < from) throw P.bad('Période invalide.');
  const nowMs = Date.now();
  const fromIso = new Date(rh.parisMidnightMs(from)).toISOString(), toIso = new Date(rh.parisMidnightMs(rh.addDays(to, 1))).toISOString();
  const rows = db.prepare(`SELECT i.*, m.name AS machine_name FROM machine_incidents i JOIN machines m ON m.id = i.machine_id
    WHERE i.started_at < ? AND (i.ended_at IS NULL OR i.ended_at > ?) ORDER BY i.started_at DESC LIMIT 300`).all(toIso, fromIso);
  res.json({ incidents: rows.map(i => P.incidentOut(i, nowMs)) });
}));

router.post('/machines/:id/incidents', R((req, res) => {
  const b = req.body || {};
  P.openIncident({ machineId: Number(req.params.id), reason: b.reason, note: b.note });
  res.status(201).json({ machines: P.board() });
}));

router.post('/incidents/:id/resolve', R((req, res) => { P.resolveIncident(Number(req.params.id)); res.json({ machines: P.board() }); }));

// ---------- programmes de lavage, types de linge, réglages ----------
router.get('/reference', R((req, res) => { res.json({ programs: P.programs(), linenTypes: P.linenTypes(), settings: P.getSettings() }); }));

router.post('/programs', R((req, res) => { const id = P.saveProgram(null, req.body || {}); res.status(201).json({ id, programs: P.programs() }); }));
router.put('/programs/:id', R((req, res) => { P.saveProgram(Number(req.params.id), req.body || {}); res.json({ programs: P.programs() }); }));
router.delete('/programs/:id', R((req, res) => { const r = P.deleteProgram(Number(req.params.id)); res.json({ ...r, programs: P.programs() }); }));

router.post('/linen-types', R((req, res) => { const id = P.saveLinenType(null, req.body || {}); res.status(201).json({ id, linenTypes: P.linenTypes() }); }));
router.put('/linen-types/:id', R((req, res) => { P.saveLinenType(Number(req.params.id), req.body || {}); res.json({ linenTypes: P.linenTypes() }); }));
router.delete('/linen-types/:id', R((req, res) => { const r = P.deleteLinenType(Number(req.params.id)); res.json({ ...r, linenTypes: P.linenTypes() }); }));

router.get('/settings', R((req, res) => { res.json({ settings: P.getSettings() }); }));
router.put('/settings', R((req, res) => { res.json({ settings: P.saveSettings(req.body || {}) }); }));

// ---------- heures et tableau de bord ----------
router.get('/hours', R((req, res) => { res.json(P.hoursView(String(req.query.from || ''), String(req.query.to || ''))); }));
router.get('/stats', R((req, res) => { res.json(P.stats(String(req.query.from || ''), String(req.query.to || ''))); }));

module.exports = router;
