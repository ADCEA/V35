// Contrôle (lecture seule) des quantités des factures émises.
//
// Avant la correction des quantités livrées, la quantité livrée ne pouvait plus être rectifiée dès qu'une commande
// était « prête » : une livraison incomplète pouvait être facturée comme commandée. Le logiciel ne connaît pas la
// quantité réellement livrée si personne ne l'a saisie ; il peut en revanche repérer deux choses, dans la vraie base :
//
//  1. « écart » : la facture ne correspond plus aux données de ses commandes. On reconstruit les lignes telles que le
//     moteur les produirait aujourd'hui (mêmes règles : niveau de détail, quantités livrées) et on les compare aux
//     lignes enregistrées sur la facture. Typique d'une commande modifiée après coup (retour en arrière du statut,
//     article ajouté après facturation…). Un brouillon retouché à la main avant émission apparaît aussi : à juger.
//  2. « signalé » : une commande facturée au complet (livré = commandé partout) dont une note ou un commentaire
//     parle d'un manque ou d'une livraison partielle, sans commande de complément ni quantité corrigée.
//
// Les autres factures ont des quantités cohérentes avec leurs commandes, mais « livré = commandé » n'est pas vérifiable
// par le logiciel : à comparer aux bons de livraison signés.
// Rien n'est écrit ici.

const db = require('../db');
const engine = require('./engine');

const { lineCents } = engine;

const SHORTAGE_RE = /manqu|incompl|partiel|reliquat|compl[eé]ment|pas (?:[ée]t[ée] )?(?:livr|pris|rendu)|non livr|en moins/i;
const FOLLOWUP_NOTE = 'Commande de complément suite à livraison partielle de ';

const norm = (s) => String(s || '').trim().toLowerCase();
// Une ligne « un BL = un montant » (niveau per_bl) se retrouve par son numéro de BL, pas par sa date.
const keyOf = (description, level) => {
  if (level === 'per_bl') { const m = /BL (\S+) livré/.exec(description || ''); if (m) return 'BL ' + m[1]; }
  return norm(description);
};

function sentMap() {
  return new Map(db.prepare(`SELECT invoice_id AS id, MAX(sent_at) AS at FROM native_mail_log
    WHERE kind = 'invoice' AND invoice_id IS NOT NULL AND status <> 'failed' GROUP BY invoice_id`).all().map(r => [r.id, r.at]));
}

function auditInvoice(inv, sentAt) {
  const orders = db.prepare(`SELECT o.* FROM native_invoice_orders no JOIN orders o ON o.id = no.order_id WHERE no.invoice_id = ? ORDER BY o.livraison_prevue, o.id`).all(inv.id);
  if (!orders.length) return null;                       // facture libre ou issue d'un devis : aucune commande à comparer
  const itemsStmt = db.prepare('SELECT name, sage_code AS sageCode, qty, delivered_qty AS deliveredQty, price FROM order_items WHERE order_id = ? ORDER BY id');
  const withItems = orders.map(o => ({ id: o.id, ticket: o.ticket, livraisonPrevue: o.livraison_prevue, items: itemsStmt.all(o.id) }));

  // 1. écarts : lignes attendues aujourd'hui ↔ lignes enregistrées sur la facture
  const expected = new Map(); const invoiced = new Map();
  const add = (m, key, name, qty, cents) => { const g = m.get(key) || { name, qty: 0, cents: 0 }; g.qty += qty; g.cents += cents; m.set(key, g); };
  for (const l of engine.buildNativeLines(withItems, inv.detail_level, 0)) {
    if (!l.isSection) add(expected, keyOf(l.description, inv.detail_level), l.description, l.quantity, lineCents(l.quantity, l.unitPrice));
  }
  for (const l of db.prepare('SELECT description, quantity, line_ht_cents AS cents FROM native_invoice_lines WHERE invoice_id = ? AND is_section = 0').all(inv.id)) {
    add(invoiced, keyOf(l.description, inv.detail_level), l.description, l.quantity, l.cents);
  }
  const diffs = [];
  for (const key of new Set([...expected.keys(), ...invoiced.keys()])) {
    const a = invoiced.get(key); const b = expected.get(key);
    const qa = a ? a.qty : 0; const qb = b ? b.qty : 0; const ca = a ? a.cents : 0; const cb = b ? b.cents : 0;
    if (Math.abs(qa - qb) < 1e-9 && ca === cb) continue;
    diffs.push({
      article: (a || b).name.replace(/^Prestation de blanchisserie — /, ''),
      kind: Math.abs(qa - qb) >= 1e-9 ? 'quantité' : 'prix',
      invoicedQty: qa, currentQty: qb, invoicedHtCents: ca, currentHtCents: cb,
    });
  }

  // 2. livraisons signalées incomplètes mais facturées au complet
  const hints = [];
  const commentsStmt = db.prepare('SELECT author, text FROM order_comments WHERE order_id = ? ORDER BY created_at');
  const followupStmt = db.prepare('SELECT 1 FROM orders WHERE notes LIKE ? LIMIT 1');
  for (const o of orders) {
    const items = itemsStmt.all(o.id);
    if (!items.length || items.some(i => (i.deliveredQty ?? i.qty) !== i.qty)) continue;    // une quantité a déjà été corrigée
    if (String(o.notes || '').startsWith(FOLLOWUP_NOTE)) continue;                           // c'est elle-même une commande de complément
    if (followupStmt.get(FOLLOWUP_NOTE + o.ticket + '%')) continue;                          // un complément a déjà été créé
    const texts = [{ author: null, text: o.notes }, ...commentsStmt.all(o.id)];
    const hit = texts.find(t => t.text && SHORTAGE_RE.test(t.text));
    if (hit) hints.push({ ticket: o.ticket, author: hit.author || null, text: String(hit.text).slice(0, 300) });
  }

  const credited = db.prepare(`SELECT COALESCE(SUM(total_ht_cents), 0) AS c FROM native_invoices WHERE credits_invoice_id = ? AND kind = 'credit_note' AND status = 'issued'`).get(inv.id).c;
  const client = db.prepare('SELECT societe FROM clients WHERE id = ?').get(inv.client_id);
  return {
    id: inv.id, number: inv.number, issueDate: inv.issue_date, clientName: client ? client.societe : '—',
    totalHtCents: inv.total_ht_cents, sentAt: sentAt || null, creditedHtCents: credited,
    orders: orders.map(o => o.ticket),
    status: diffs.length ? 'ecart' : hints.length ? 'signale' : 'ok',
    diffs, hints,
  };
}

/** Toutes les factures émises (non annulées par un avoir total) rattachées à des commandes, avec leur verdict. */
function auditInvoices() {
  const sent = sentMap();
  const invoices = db.prepare(`
    SELECT ni.* FROM native_invoices ni
    WHERE ni.kind = 'invoice' AND ni.status = 'issued'
      AND NOT EXISTS (SELECT 1 FROM native_invoices cn WHERE cn.credits_invoice_id = ni.id AND cn.status = 'issued' AND cn.is_full_credit = 1)
    ORDER BY ni.issue_date DESC, ni.id DESC`).all();
  const rows = invoices.map(i => auditInvoice(i, sent.get(i.id))).filter(Boolean);
  const count = (st) => rows.filter(r => r.status === st).length;
  return {
    checkedAt: new Date().toISOString(),
    counts: { checked: rows.length, sent: rows.filter(r => r.sentAt).length, ecart: count('ecart'), signale: count('signale'), ok: count('ok') },
    invoices: rows,
  };
}

module.exports = { auditInvoices, SHORTAGE_RE };
