// Tournées fixes (Logistique) : planifiées à l'avance, entièrement modifiables par l'équipe.
// GET    /api/admin/logistics/tours            liste des tournées + hôtels disponibles + chauffeurs
// POST   /api/admin/logistics/tours            création { name, driverId, weekdays[], clientIds[], active, notes }
// PUT    /api/admin/logistics/tours/:id        modification (champs facultatifs ; clientIds remplace l'ordre de passage)
// DELETE /api/admin/logistics/tours/:id        suppression (les commandes qu'elle avait affectées redeviennent « non assigné »)
// GET    /api/admin/logistics/tours/plan?date  ce qui roule un jour donné (par défaut demain) et les commandes des hôtels concernés
// POST   /api/admin/logistics/tours/apply      affecte maintenant les commandes en attente à leur tournée
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const ft = require('../utils/fixedTours');

const router = express.Router();
router.use(requireAdmin);

const clean = (v, n) => String(v ?? '').trim().slice(0, n);

function tourView(t) {
  const clients = db.prepare(`
    SELECT cl.id, cl.societe, cl.adresse, c.position
    FROM fixed_tour_clients c JOIN clients cl ON cl.id = c.client_id WHERE c.tour_id = ? ORDER BY c.position, cl.societe
  `).all(t.id);
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE tour_id = ? AND status IN ('recue', 'traitement', 'prete')`).get(t.id).n;
  return {
    id: t.id, name: t.name, driverId: t.driver_id, active: !!t.active, notes: t.notes || '',
    weekdays: ft.parseDays(t.weekdays), clients, pendingOrders: pending,
  };
}

/** Lit et valide le corps de la requête ; renvoie { error } ou les valeurs normalisées (clés absentes = non modifiées). */
function readBody(body, current) {
  const b = body || {};
  const out = {};
  if (b.name !== undefined || !current) {
    out.name = clean(b.name, 60);
    if (!out.name) return { error: 'Donnez un nom à la tournée.' };
  }
  if (b.driverId !== undefined) {
    if (b.driverId === null || b.driverId === '') out.driverId = null;
    else {
      const id = Number(b.driverId);
      if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM drivers WHERE id = ?').get(id)) return { error: 'Chauffeur introuvable.' };
      out.driverId = id;
    }
  }
  if (b.weekdays !== undefined) {
    if (!Array.isArray(b.weekdays) || b.weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) return { error: 'Jours invalides (1 = lundi … 7 = dimanche).' };
    out.weekdays = [...new Set(b.weekdays)].sort((a, c) => a - c);
  }
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  if (b.notes !== undefined) out.notes = clean(b.notes, 500) || null;
  if (b.clientIds !== undefined) {
    if (!Array.isArray(b.clientIds)) return { error: 'Liste d\'hôtels invalide.' };
    const ids = [...new Set(b.clientIds.map(Number))];
    if (ids.some(i => !Number.isInteger(i))) return { error: 'Liste d\'hôtels invalide.' };
    if (ids.length > 200) return { error: 'Trop d\'hôtels dans une même tournée.' };
    const known = new Set(db.prepare(`SELECT id FROM clients WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids).map(r => r.id));
    if (ids.some(i => !known.has(i))) return { error: 'Un des hôtels n\'existe plus.' };
    out.clientIds = ids;
  }
  return { values: out };
}

function save(id, v, current) {
  const merged = {
    name: v.name ?? current?.name,
    driverId: v.driverId !== undefined ? v.driverId : (current?.driver_id ?? null),
    weekdays: v.weekdays ?? ft.parseDays(current?.weekdays),
    active: v.active ?? (current ? current.active : 1),
    notes: v.notes !== undefined ? v.notes : (current?.notes ?? null),
  };
  const clientIds = v.clientIds ?? (current ? db.prepare('SELECT client_id FROM fixed_tour_clients WHERE tour_id = ? ORDER BY position').all(current.id).map(r => r.client_id) : []);
  if (merged.active) {
    const conflict = ft.findConflict(id, merged.weekdays, clientIds);
    if (conflict) return { error: `${conflict.societe} est déjà dans la tournée « ${conflict.tour} » le ${conflict.days.join(', ')}. Un hôtel ne peut être que dans une tournée par jour.` };
  }
  let tourId = id;
  db.transaction(() => {
    if (current) ft.releaseTour(current.id);
    if (current) {
      db.prepare('UPDATE fixed_tours SET name = ?, driver_id = ?, weekdays = ?, active = ?, notes = ? WHERE id = ?')
        .run(merged.name, merged.driverId, merged.weekdays.join(','), merged.active, merged.notes, current.id);
    } else {
      tourId = db.prepare('INSERT INTO fixed_tours (name, driver_id, weekdays, active, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(merged.name, merged.driverId, merged.weekdays.join(','), merged.active, merged.notes, new Date().toISOString()).lastInsertRowid;
    }
    db.prepare('DELETE FROM fixed_tour_clients WHERE tour_id = ?').run(tourId);
    const ins = db.prepare('INSERT INTO fixed_tour_clients (tour_id, client_id, position) VALUES (?, ?, ?)');
    clientIds.forEach((cid, i) => ins.run(tourId, cid, i));
  })();
  const assigned = ft.assignPending();
  return { tour: tourView(db.prepare('SELECT * FROM fixed_tours WHERE id = ?').get(tourId)), assigned };
}

router.get('/', (req, res) => {
  ft.assignPending();
  const tours = db.prepare('SELECT * FROM fixed_tours ORDER BY name COLLATE NOCASE, id').all().map(tourView);
  const clients = db.prepare('SELECT id, societe, adresse FROM clients ORDER BY societe COLLATE NOCASE').all();
  const drivers = db.prepare('SELECT id, name FROM drivers ORDER BY name').all();
  res.json({ tours, clients, drivers, dayNames: ft.DAY_NAMES, today: ft.parisDay() });
});

router.get('/plan', (req, res) => {
  const today = ft.parisDay();
  const date = req.query.date ? String(req.query.date) : ft.addDays(today, 1);
  if (!ft.isDate(date)) return res.status(400).json({ error: 'Date invalide (AAAA-MM-JJ).' });
  const wd = ft.weekdayOf(date);
  const tours = db.prepare('SELECT * FROM fixed_tours WHERE active = 1 ORDER BY name COLLATE NOCASE').all()
    .filter(t => ft.parseDays(t.weekdays).includes(wd));
  const drivers = Object.fromEntries(db.prepare('SELECT id, name FROM drivers').all().map(d => [d.id, d.name]));
  const orders = db.prepare(`SELECT id, ticket, status, driver_id FROM orders WHERE client_id = ? AND status IN ('recue', 'traitement', 'prete') ORDER BY created_at, id`);
  res.json({
    date, weekday: wd, dayName: ft.DAY_NAMES[wd - 1],
    tours: tours.map(t => {
      const v = tourView(t);
      return {
        id: v.id, name: v.name, driverId: v.driverId, driverName: drivers[v.driverId] || null,
        stops: v.clients.map(c => ({ clientId: c.id, societe: c.societe, adresse: c.adresse, position: c.position + 1, orders: orders.all(c.id).map(o => ({ id: o.id, ticket: o.ticket, status: o.status })) })),
      };
    }),
  });
});

router.post('/apply', (req, res) => {
  res.json({ assigned: ft.assignPending() });
});

router.post('/', (req, res) => {
  const r = readBody(req.body, null);
  if (r.error) return res.status(400).json({ error: r.error });
  const out = save(null, r.values, null);
  if (out.error) return res.status(409).json({ error: out.error });
  res.status(201).json(out);
});

router.put('/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM fixed_tours WHERE id = ?').get(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Tournée introuvable.' });
  const r = readBody(req.body, current);
  if (r.error) return res.status(400).json({ error: r.error });
  const out = save(current.id, r.values, current);
  if (out.error) return res.status(409).json({ error: out.error });
  res.json(out);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM fixed_tours WHERE id = ?').get(id)) return res.status(404).json({ error: 'Tournée introuvable.' });
  db.transaction(() => { ft.releaseTour(id); db.prepare('DELETE FROM fixed_tours WHERE id = ?').run(id); })();
  res.json({ ok: true, assigned: ft.assignPending() });
});

module.exports = router;
