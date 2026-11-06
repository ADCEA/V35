// Badgeuse : API de la tablette de l'atelier. Chaque tablette porte un jeton (créé dans Équipe → Badgeuses, révocable) ;
// le collaborateur s'identifie par son code personnel (ou son badge) et pointe arrivée, changement de poste, pause ou départ.
// L'heure fait foi côté serveur ; un collaborateur n'est jamais identifié sans son code.
const express = require('express');
const db = require('../db');
const security = require('../middleware/security');
const rh = require('../utils/rh');
const store = require('../utils/rhStore');

const router = express.Router();
router.use(security.rateLimit({ name: 'badgeuse', windowMs: 10 * 60 * 1000, max: 900, message: 'Trop de demandes. Réessayez dans quelques minutes.' }));

const { requireTerminal, authenticate, fail } = require('../utils/rhAuth');

router.use(requireTerminal);

// ---------- présentation ----------
const machineName = (id) => { if (!id) return null; const m = store.machineById.get(id); return m ? m.name : null; };

function presentOut(open, nowMs) {
  if (!open) return null;
  const s = Date.parse(open.started_at);
  return {
    since: open.started_at, minutes: Math.max(0, Math.round((nowMs - s) / 60000)), bu: open.bu, machineId: open.machine_id,
    machineName: machineName(open.machine_id), poste: store.posteLabel(open.bu, machineName(open.machine_id)),
  };
}

function employeeOut(e) {
  const m = e.machine_id ? store.machineById.get(e.machine_id) : null;
  const usable = m && m.active ? m : null;
  return {
    id: e.id, firstName: e.first_name, lastName: e.last_name, name: `${e.first_name} ${e.last_name}`.trim(),
    bu: e.bu, machineId: usable ? usable.id : null, machineName: usable ? usable.name : null,
  };
}

// GET /api/badgeuse/state — liste des collaborateurs (qui est là, qui n'y est pas), machines et unités.
router.get('/state', (req, res) => {
  const nowMs = Date.now();
  const machines = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY sort_order, name').all();
  const open = new Map(store.allOpenEntries().map(e => [e.employee_id, e]));
  const employees = db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE').all().map(e => {
    const o = open.get(e.id);
    const present = o && !store.isStale(o, nowMs) ? presentOut(o, nowMs) : null;
    return { ...employeeOut(e), hasPin: !!e.pin_hash, present };
  });
  res.json({
    now: new Date(nowMs).toISOString(), terminal: { id: req.terminal.id, label: req.terminal.label },
    bus: rh.BUS, machines: machines.map(m => ({ id: m.id, name: m.name, bu: m.bu, capacityKg: m.capacity_kg })), employees,
  });
});

function statusBody(e, nowMs, extra) {
  const open = store.openEntry(e.id);
  const live = open && !store.isStale(open, nowMs) ? open : null;
  return { employee: employeeOut(e), present: presentOut(live, nowMs), forgotten: !!(open && !live), minutesToday: store.minutesToday(e.id, nowMs), ...(extra || {}) };
}

// POST /api/badgeuse/identify { employeeId, pin } ou { uid } — vérifie l'identité et renvoie l'état (présent ? où ? depuis quand ?).
router.post('/identify', (req, res) => {
  const e = authenticate(req, res);
  if (!e) return;
  res.json(statusBody(e, Date.now()));
});

const ACTIONS = ['in', 'switch', 'pause', 'out'];

// POST /api/badgeuse/punch { employeeId, pin | uid, action, bu?, machineId? }
router.post('/punch', (req, res) => {
  const action = String((req.body || {}).action || '');
  if (!ACTIONS.includes(action)) return fail(res, 400, 'Action inconnue.');
  const e = authenticate(req, res);
  if (!e) return;

  const nowMs = Date.now();
  const terminalId = req.terminal.id;
  let target = null;
  if (action === 'in' || action === 'switch') {
    const asked = req.body.machineId != null && req.body.machineId !== '' ? { machineId: req.body.machineId } : (req.body.bu ? { bu: req.body.bu } : null);
    const dflt = employeeOut(e);
    target = store.resolvePoste(asked || { bu: dflt.bu, machineId: dflt.machineId });
    if (target.error) return fail(res, 400, target.error);
  }

  let outcome;
  try {
    outcome = db.transaction(() => {
      let open = store.openEntry(e.id);
      let forgotten = false;
      // Badge oublié la veille : le tronçon resté ouvert est refermé pour une durée nulle et signalé au responsable.
      if (open && store.isStale(open, nowMs)) { store.closeEntry(open.id, Date.parse(open.started_at), 'oubli'); open = null; forgotten = true; }

      if (action === 'in') {
        if (open) { const err = new Error('Déjà pointé.'); err.code = 'ALREADY_IN'; throw err; }
        store.startEntry({ employeeId: e.id, atMs: nowMs, bu: target.bu, machineId: target.machineId, terminalId });
        return { forgotten, did: 'in' };
      }
      if (action === 'switch') {
        if (open && open.bu === target.bu && (open.machine_id || null) === (target.machineId || null)) { const err = new Error('Déjà à ce poste.'); err.code = 'SAME_POSTE'; throw err; }
        if (open) store.closeEntry(open.id, nowMs, 'poste');
        store.startEntry({ employeeId: e.id, atMs: nowMs, bu: target.bu, machineId: target.machineId, terminalId });
        return { forgotten, did: open ? 'switch' : 'in' };
      }
      // pause / out
      if (!open) {
        if (forgotten) return { forgotten, did: 'forgotten' };
        const err = new Error('Pas pointé.'); err.code = 'NOT_IN'; throw err;
      }
      store.closeEntry(open.id, nowMs, action === 'pause' ? 'pause' : 'depart');
      return { forgotten, did: action };
    })();
  } catch (err) {
    const msgs = {
      ALREADY_IN: ['Vous êtes déjà pointé(e).', 'ALREADY_IN'],
      SAME_POSTE: ['Vous êtes déjà à ce poste.', 'SAME_POSTE'],
      NOT_IN: ['Vous n\'êtes pas pointé(e) : faites d\'abord « Arrivée ».', 'NOT_IN'],
    };
    if (msgs[err.code]) return fail(res, 409, msgs[err.code][0], { code: msgs[err.code][1], ...statusBody(e, nowMs) });
    throw err;
  }

  const hh = rh.hhmm(nowMs);
  const poste = target ? store.posteLabel(target.bu, target.machine ? target.machine.name : null) : null;
  const messages = {
    in: `Arrivée enregistrée à ${hh} — ${poste}.`,
    switch: `Poste changé à ${hh} — ${poste}.`,
    pause: `Pause enregistrée à ${hh}.`,
    out: `Départ enregistré à ${hh}. À bientôt !`,
    forgotten: 'Votre départ de la veille n\'avait pas été badgé : le responsable a été prévenu.',
  };
  res.json({ ok: true, action: outcome.did, message: (outcome.forgotten && outcome.did !== 'forgotten' ? 'Départ de la veille non badgé (signalé au responsable). ' : '') + messages[outcome.did], ...statusBody(e, nowMs) });
});

module.exports = router;
