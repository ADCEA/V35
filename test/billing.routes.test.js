// Routes HTTP des ventes : câblage, verrou, ressaisie, formats de réponse.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'); const path = require('path'); const fs = require('fs');
const Database = require('better-sqlite3');
const { startServer } = require('./helpers');

const B = '/api/admin/billing';
const CODE = 'code-routes-123';

test('routes ventes : tableau de bord, liste, devis, lot, relevé, relances', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cezanne-routes-'));
  const s = await startServer({ dataDir });
  t.after(() => s.stop());
  const { call } = s;
  const step = async (scope, method, url, body, raw) => { assert.equal((await call('POST', `${B}/lock/confirm`, { code: CODE, scope })).status, 200); return call(method, url, body, raw); };

  await call('POST', '/api/admin/setup', { password: 'secret123' });
  await call('POST', `${B}/lock/setup`, { code: CODE, confirm: CODE });

  // Données : réglages complets + un hôtel avec SIRET valide + 1 BL livré
  const raw = new Database(path.join(dataDir, 'database.sqlite'));
  raw.prepare(`UPDATE billing_settings SET share_capital='10 000 €', siren='552100554', siret='55210055400013', vat_number='FR40552100554', rcs='RCS Avignon', iban='FR76', email='c@x.fr' WHERE id=1`).run();
  const cid = Number(raw.prepare(`INSERT INTO clients (email, societe, contact, tel, adresse, code_postal, ville, code_hash, siret) VALUES ('h@x.fr','Hôtel Routes','J','06','1 rue','84000','Avignon','x','55210055400013')`).run().lastInsertRowid);
  const oid = Number(raw.prepare(`INSERT INTO orders (ticket, client_id, societe, contact, tel, adresse, livraison_prevue, status) VALUES ('CZ-1',?,?,?,?,?,?, 'livree')`).run(cid, 'H', 'J', '06', 'a', '2026-10-01').lastInsertRowid);
  raw.prepare(`INSERT INTO order_items (order_id, service_id, name, code, sage_code, price, qty, delivered_qty) VALUES (?,?,?,?,?,?,?,?)`).run(oid, 'd', 'Drap', 'D', 'DRAP', 2, 100, 100);

  // Tableau de bord (vide d'abord, puis avec le BL à facturer)
  let r = await call('GET', `${B}/dashboard`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.toInvoice.orders, r.data.toInvoice.htCents, r.data.series.length], [1, 20000, 12]);
  assert.ok(['ok', 'warning', 'critical'].includes(r.data.backup.health));

  // Facturation en lot : aperçu → brouillons → émission (ressaisie exigée)
  r = await call('GET', `${B}/batch/preview?upTo=2026-10-31`);
  assert.equal(r.data.clients[0].clientName, 'Hôtel Routes');
  r = await call('POST', `${B}/batch/drafts`, { clientIds: [cid], upTo: '2026-10-31' });
  const draftId = r.data.results[0].invoiceId; assert.ok(draftId);
  assert.equal((await call('POST', `${B}/batch/issue`, { invoiceIds: [draftId], issueDate: '2026-10-31' })).status, 403);
  r = await step('batch-issue', 'POST', `${B}/batch/issue`, { invoiceIds: [draftId], issueDate: '2026-10-31' });
  assert.equal(r.data.results[0].number, 'FA-2026-000001');

  // Liste filtrée
  r = await call('GET', `${B}/invoices?tab=open&q=routes`);
  assert.equal(r.data.total, 1); assert.ok(['unpaid', 'overdue'].includes(r.data.invoices[0].display));
  assert.equal(r.data.counts.open, 1);
  r = await call('GET', `${B}/invoices?tab=nimporte&sort=zzz`);
  assert.equal(r.status, 200, 'onglet / tri inconnus : valeurs par défaut');

  // Détail enrichi
  r = await call('GET', `${B}/invoices/${draftId}`);
  assert.equal(r.data.invoice.clientEmail, 'h@x.fr');
  assert.ok(Array.isArray(r.data.invoice.timeline) && r.data.invoice.timeline.some(x => x.type === 'issued'));
  assert.equal(r.data.invoice.pennylane, null);

  // Facture libre
  r = await call('POST', `${B}/invoices/free`, { clientId: cid, lines: [{ description: 'Nettoyage tapis', quantity: 2, unitPrice: 45, vatRate: 20 }], reference: 'Tapis salon' });
  assert.equal(r.status, 201); assert.equal(r.data.invoice.totalHtCents, 9000); assert.equal(r.data.invoice.reference, 'Tapis salon');
  assert.equal((await call('POST', `${B}/invoices/free`, { clientId: cid, lines: [] })).status, 400);

  // Devis
  r = await call('POST', `${B}/quotes`, { clientId: cid, lines: [{ description: 'Location nappes', quantity: 10, unitPrice: 4, vatRate: 20 }] });
  const qid = r.data.quote.id; assert.equal(r.status, 201);
  r = await call('POST', `${B}/quotes/${qid}/issue`, { issueDate: '2026-10-31' });
  assert.equal(r.data.quote.number, 'DE-2026-0001');
  const qpdf = await call('GET', `${B}/quotes/${qid}/pdf`, null, true);
  assert.equal(qpdf.headers.get('content-type'), 'application/pdf');
  r = await call('POST', `${B}/quotes/${qid}/convert`, {});
  assert.equal(r.status, 201); assert.equal(r.data.quote.status, 'invoiced'); assert.equal(r.data.quote.invoiceNumber, null);
  r = await call('GET', `${B}/quotes?status=invoiced`);
  assert.equal(r.data.quotes.length, 1); assert.equal(r.data.counts.all, 1);

  // E-mails : prévisualisation (le SMTP n'est pas configuré dans ce test → 503 à l'envoi)
  r = await call('GET', `${B}/invoices/${draftId}/mail-preview?kind=reminder-1`);
  assert.equal(r.status, 200); assert.match(r.data.subject, /Rappel/); assert.equal(r.data.to, 'h@x.fr'); assert.equal(r.data.smtp, false);
  r = await call('POST', `${B}/invoices/${draftId}/send`, { to: 'h@x.fr', subject: 's', body: 'b' });
  assert.equal(r.status, 503);
  r = await call('POST', `${B}/invoices/${draftId}/remind`, { level: 1, channel: 'manual', subject: 'Appelé' });
  assert.equal(r.status, 200); assert.equal(r.data.logged, true);
  r = await call('GET', `${B}/reminders`);
  assert.equal(r.status, 200); assert.ok(Array.isArray(r.data.invoices));

  // Relevé bancaire
  const csv = 'Date;Libellé;Montant\n05/11/2026;VIR HOTEL ROUTES FA-2026-000001;240,00\n';
  r = await call('POST', `${B}/reconcile/parse`, { csv });
  assert.equal(r.status, 200); assert.equal(r.data.complete, true);
  const line = r.data.lines[0]; assert.equal(line.confidence, 'high'); assert.equal(line.candidates[0].invoiceId, draftId);
  r = await call('POST', `${B}/reconcile/apply`, { items: [{ fingerprint: line.fingerprint, date: line.date, label: line.label, allocations: [{ invoiceId: draftId, amountCents: 24000 }] }] });
  assert.equal(r.data.applied, 1);
  r = await call('GET', `${B}/payments`);
  assert.equal(r.data.count, 1); assert.equal(r.data.payments[0].fromBank, true);
  r = await call('GET', `${B}/invoices?tab=paid`);
  assert.equal(r.data.total, 1);

  // Sauvegarde manuelle + statut + téléchargement soumis à la ressaisie
  r = await call('POST', `${B}/backup/run`, {});
  assert.equal(r.status, 200); assert.equal(r.data.status, 'partial', 'copie locale seulement : aucune destination hors serveur dans ce test');
  r = await call('GET', `${B}/backup/status`);
  assert.equal(r.data.runs.length, 1); assert.equal(r.data.health, 'warning');
  const runId = r.data.runs[0].id;
  assert.equal((await call('GET', `${B}/backup/${runId}/download`, null, true)).status, 403);
  const dl = await step(`backup:${runId}`, 'GET', `${B}/backup/${runId}/download`, null, true);
  assert.equal(dl.status, 200); assert.ok((await dl.arrayBuffer()).byteLength > 1000);

  // Tout est refusé une fois verrouillé
  await call('POST', `${B}/lock/lock`);
  for (const u of ['/dashboard', '/quotes', '/payments', '/reminders', '/batch/preview', '/backup/status']) assert.equal((await call('GET', B + u)).status, 423, u);
  assert.deepEqual(raw.pragma('integrity_check', { simple: true }), 'ok');
  raw.close();
});
