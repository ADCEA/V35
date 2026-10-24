// Schéma de la facturation intégrée (tables native_*).
//
// Appelé une fois par db.js au démarrage. Tout est idempotent (IF NOT EXISTS)
// et indépendant des tables `invoices` / `invoice_orders` du flux Odoo, qui
// ne sont jamais modifiées.
//
// Principe d'inaltérabilité : une facture n'est modifiable que tant qu'elle
// est « draft ». Dès qu'elle est « issued » (numérotée), des triggers SQL
// refusent toute modification ou suppression de la facture, de ses lignes
// et de ses liens BL — y compris depuis un script ou la console SQLite. Une
// erreur se corrige par un avoir, jamais par une modification.

module.exports = function applyBillingSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_settings (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      -- 'native' = facturation intégrée à l'application ; 'odoo' = flux Odoo existant.
      engine              TEXT NOT NULL DEFAULT 'native' CHECK (engine IN ('native','odoo')),
      -- Identité de l'émetteur (mentions légales obligatoires).
      legal_name          TEXT,
      legal_form          TEXT,
      share_capital       TEXT,
      siren               TEXT,
      siret               TEXT,
      vat_number          TEXT,
      rcs                 TEXT,
      address_line        TEXT,
      postal_code         TEXT,
      city                TEXT,
      country             TEXT NOT NULL DEFAULT 'FR',
      email               TEXT,
      phone               TEXT,
      iban                TEXT,
      bic                 TEXT,
      -- Conditions commerciales.
      default_vat_rate    REAL NOT NULL DEFAULT 20,
      payment_terms_days  INTEGER NOT NULL DEFAULT 30,
      late_penalty_text   TEXT NOT NULL DEFAULT 'Pénalités de retard : 3 fois le taux d''intérêt légal en vigueur, exigibles sans rappel à compter de la date d''échéance.',
      -- 1 = option pour le paiement de la TVA d'après les débits (mention
      -- obligatoire sur les prestations de services dans ce cas).
      vat_on_debits       INTEGER NOT NULL DEFAULT 0,
      invoice_prefix      TEXT NOT NULL DEFAULT 'FA',
      credit_prefix       TEXT NOT NULL DEFAULT 'AV',
      footer_note         TEXT
    );

    CREATE TABLE IF NOT EXISTS native_invoice_seq (
      seq_key  TEXT PRIMARY KEY,      -- ex. 'invoice-2026', 'credit_note-2026'
      value    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS native_invoices (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      kind               TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit_note')),
      status             TEXT NOT NULL DEFAULT 'draft'   CHECK (status IN ('draft','issued')),
      -- Numéro définitif, attribué uniquement à l'émission (jamais sur un brouillon).
      number             TEXT UNIQUE,
      seq_year           INTEGER,
      seq_no             INTEGER,
      -- Rang dans la chaîne globale d'intégrité (toutes factures et avoirs confondus).
      chain_no           INTEGER UNIQUE,
      client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      credits_invoice_id INTEGER REFERENCES native_invoices(id) ON DELETE RESTRICT,
      is_full_credit     INTEGER NOT NULL DEFAULT 0,
      credit_reason      TEXT,
      issue_date         TEXT,
      due_date           TEXT,
      period_start       TEXT,
      period_end         TEXT,
      operation_category TEXT NOT NULL DEFAULT 'services' CHECK (operation_category IN ('services','goods','mixed')),
      detail_level       TEXT NOT NULL DEFAULT 'detail',
      reference          TEXT,
      notes              TEXT,
      -- Identités figées à l'émission : une modification ultérieure de la fiche
      -- client ou des réglages ne change jamais un document déjà émis.
      seller_json        TEXT,
      buyer_json         TEXT,
      terms_json         TEXT,
      total_ht_cents     INTEGER NOT NULL DEFAULT 0,
      total_vat_cents    INTEGER NOT NULL DEFAULT 0,
      total_ttc_cents    INTEGER NOT NULL DEFAULT 0,
      vat_breakdown_json TEXT NOT NULL DEFAULT '[]',
      prev_hash          TEXT,
      hash               TEXT,
      issued_at          TEXT,
      -- Transmission à une plateforme agréée : seule partie modifiable après émission.
      pa_status          TEXT NOT NULL DEFAULT 'not_sent',
      pa_reference       TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_native_invoices_client ON native_invoices(client_id);
    CREATE INDEX IF NOT EXISTS idx_native_invoices_credits ON native_invoices(credits_invoice_id);

    CREATE TABLE IF NOT EXISTS native_invoice_lines (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id        INTEGER NOT NULL REFERENCES native_invoices(id) ON DELETE CASCADE,
      position          INTEGER NOT NULL,
      is_section        INTEGER NOT NULL DEFAULT 0,
      sage_code         TEXT,
      description       TEXT NOT NULL,
      quantity          REAL NOT NULL DEFAULT 0,
      unit_price        REAL NOT NULL DEFAULT 0,
      vat_rate          REAL NOT NULL DEFAULT 0,
      line_ht_cents     INTEGER NOT NULL DEFAULT 0,
      -- Pour un avoir : ligne de la facture d'origine qui est créditée.
      credit_of_line_id INTEGER REFERENCES native_invoice_lines(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_native_lines_invoice ON native_invoice_lines(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_native_lines_credit_of ON native_invoice_lines(credit_of_line_id);

    CREATE TABLE IF NOT EXISTS native_invoice_orders (
      invoice_id  INTEGER NOT NULL REFERENCES native_invoices(id) ON DELETE CASCADE,
      order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      PRIMARY KEY (invoice_id, order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_native_invoice_orders_order ON native_invoice_orders(order_id);

    -- Règlements : append-only. Une erreur de saisie se corrige par une
    -- écriture inverse (montant négatif), jamais par modification.
    CREATE TABLE IF NOT EXISTS native_payments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id    INTEGER NOT NULL REFERENCES native_invoices(id) ON DELETE RESTRICT,
      paid_on       TEXT NOT NULL,
      amount_cents  INTEGER NOT NULL CHECK (amount_cents <> 0),
      method        TEXT NOT NULL DEFAULT 'virement',
      reference     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_native_payments_invoice ON native_payments(invoice_id);

    -- Devis : document commercial (non comptable), numéroté DE-AAAA-NNNN à la
    -- finalisation, convertible en brouillon de facture.
    CREATE TABLE IF NOT EXISTS native_quotes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','accepted','refused','invoiced')),
      number           TEXT UNIQUE,
      seq_year         INTEGER,
      seq_no           INTEGER,
      client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      issue_date       TEXT,
      valid_until      TEXT,
      reference        TEXT,
      notes            TEXT,
      operation_category TEXT NOT NULL DEFAULT 'services' CHECK (operation_category IN ('services','goods','mixed')),
      total_ht_cents   INTEGER NOT NULL DEFAULT 0,
      total_vat_cents  INTEGER NOT NULL DEFAULT 0,
      total_ttc_cents  INTEGER NOT NULL DEFAULT 0,
      vat_breakdown_json TEXT NOT NULL DEFAULT '[]',
      seller_json      TEXT,
      buyer_json       TEXT,
      terms_json       TEXT,
      invoice_id       INTEGER REFERENCES native_invoices(id) ON DELETE SET NULL,
      decided_at       TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_native_quotes_client ON native_quotes(client_id);

    CREATE TABLE IF NOT EXISTS native_quote_lines (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id      INTEGER NOT NULL REFERENCES native_quotes(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL,
      is_section    INTEGER NOT NULL DEFAULT 0,
      sage_code     TEXT,
      description   TEXT NOT NULL,
      quantity      REAL NOT NULL DEFAULT 0,
      unit_price    REAL NOT NULL DEFAULT 0,
      vat_rate      REAL NOT NULL DEFAULT 0,
      line_ht_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_native_quote_lines_quote ON native_quote_lines(quote_id);

    -- Courriers envoyés (facture, relance, devis) : append-only. Sert de
    -- chronologie sur la facture et de preuve de relance.
    CREATE TABLE IF NOT EXISTS native_mail_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER REFERENCES native_invoices(id) ON DELETE RESTRICT,
      quote_id    INTEGER REFERENCES native_quotes(id) ON DELETE RESTRICT,
      kind        TEXT NOT NULL,                 -- 'invoice' | 'reminder-1' | 'reminder-2' | 'reminder-3' | 'quote'
      channel     TEXT NOT NULL DEFAULT 'email', -- 'email' | 'manual' (relance téléphonique, courrier…)
      to_email    TEXT,
      subject     TEXT,
      status      TEXT NOT NULL,                 -- 'sent' | 'failed' | 'logged'
      error       TEXT,
      sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_native_mail_invoice ON native_mail_log(invoice_id);

    -- Suivi de l'envoi des factures émises vers Pennylane (une ligne par document).
    CREATE TABLE IF NOT EXISTS pennylane_sync (
      invoice_id     INTEGER PRIMARY KEY REFERENCES native_invoices(id) ON DELETE RESTRICT,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','error')),
      attempts       INTEGER NOT NULL DEFAULT 0,
      last_error     TEXT,
      pennylane_id   TEXT,
      customer_id    TEXT,
      sent_at        TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Verrou propre à l'espace Facturation : un code distinct du mot de passe
    -- administrateur (stocké haché), avec compteur d'échecs persistant pour
    -- résister à la force brute même après un redémarrage du serveur.
    CREATE TABLE IF NOT EXISTS billing_lock (
      id               INTEGER PRIMARY KEY CHECK (id = 1),
      code_hash        TEXT,
      failed_attempts  INTEGER NOT NULL DEFAULT 0,
      locked_until     INTEGER NOT NULL DEFAULT 0,   -- ms epoch : refus de tout essai avant cette date
      reset_marker     TEXT,                         -- dernière valeur de BILLING_LOCK_RESET appliquée
      updated_at       TEXT
    );
    INSERT OR IGNORE INTO billing_lock (id) VALUES (1);

    -- Journal d'événements : append-only et chaîné par hash.
    CREATE TABLE IF NOT EXISTS billing_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          TEXT NOT NULL,
      action      TEXT NOT NULL,
      invoice_id  INTEGER,
      detail_json TEXT NOT NULL DEFAULT '{}',
      prev_hash   TEXT,
      hash        TEXT NOT NULL
    );
  `);

  // ---------- inaltérabilité ----------
  const LOCK_MSG = "Facture émise : modification interdite. Émettez un avoir pour corriger.";
  db.exec(`
    DROP TRIGGER IF EXISTS trg_native_invoices_no_update;
    CREATE TRIGGER trg_native_invoices_no_update
    BEFORE UPDATE ON native_invoices
    WHEN OLD.status = 'issued' AND (
         NEW.status IS NOT OLD.status OR NEW.kind IS NOT OLD.kind OR NEW.number IS NOT OLD.number
      OR NEW.seq_year IS NOT OLD.seq_year OR NEW.seq_no IS NOT OLD.seq_no OR NEW.chain_no IS NOT OLD.chain_no
      OR NEW.client_id IS NOT OLD.client_id OR NEW.credits_invoice_id IS NOT OLD.credits_invoice_id
      OR NEW.is_full_credit IS NOT OLD.is_full_credit OR NEW.credit_reason IS NOT OLD.credit_reason
      OR NEW.issue_date IS NOT OLD.issue_date OR NEW.due_date IS NOT OLD.due_date
      OR NEW.period_start IS NOT OLD.period_start OR NEW.period_end IS NOT OLD.period_end
      OR NEW.operation_category IS NOT OLD.operation_category OR NEW.detail_level IS NOT OLD.detail_level
      OR NEW.reference IS NOT OLD.reference OR NEW.notes IS NOT OLD.notes
      OR NEW.seller_json IS NOT OLD.seller_json OR NEW.buyer_json IS NOT OLD.buyer_json
      OR NEW.terms_json IS NOT OLD.terms_json
      OR NEW.total_ht_cents IS NOT OLD.total_ht_cents OR NEW.total_vat_cents IS NOT OLD.total_vat_cents
      OR NEW.total_ttc_cents IS NOT OLD.total_ttc_cents OR NEW.vat_breakdown_json IS NOT OLD.vat_breakdown_json
      OR NEW.prev_hash IS NOT OLD.prev_hash OR NEW.hash IS NOT OLD.hash OR NEW.issued_at IS NOT OLD.issued_at
      OR NEW.created_at IS NOT OLD.created_at)
    BEGIN SELECT RAISE(ABORT, '${LOCK_MSG}'); END;

    DROP TRIGGER IF EXISTS trg_native_invoices_no_delete;
    CREATE TRIGGER trg_native_invoices_no_delete
    BEFORE DELETE ON native_invoices
    WHEN OLD.status = 'issued'
    BEGIN SELECT RAISE(ABORT, 'Facture émise : suppression interdite. Émettez un avoir pour corriger.'); END;

    DROP TRIGGER IF EXISTS trg_native_lines_no_insert;
    CREATE TRIGGER trg_native_lines_no_insert
    BEFORE INSERT ON native_invoice_lines
    WHEN (SELECT status FROM native_invoices WHERE id = NEW.invoice_id) = 'issued'
    BEGIN SELECT RAISE(ABORT, '${LOCK_MSG}'); END;

    DROP TRIGGER IF EXISTS trg_native_lines_no_update;
    CREATE TRIGGER trg_native_lines_no_update
    BEFORE UPDATE ON native_invoice_lines
    WHEN (SELECT status FROM native_invoices WHERE id = OLD.invoice_id) = 'issued'
    BEGIN SELECT RAISE(ABORT, '${LOCK_MSG}'); END;

    DROP TRIGGER IF EXISTS trg_native_lines_no_delete;
    CREATE TRIGGER trg_native_lines_no_delete
    BEFORE DELETE ON native_invoice_lines
    WHEN (SELECT status FROM native_invoices WHERE id = OLD.invoice_id) = 'issued'
    BEGIN SELECT RAISE(ABORT, '${LOCK_MSG}'); END;

    DROP TRIGGER IF EXISTS trg_native_orders_no_insert;
    CREATE TRIGGER trg_native_orders_no_insert
    BEFORE INSERT ON native_invoice_orders
    WHEN (SELECT status FROM native_invoices WHERE id = NEW.invoice_id) = 'issued'
    BEGIN SELECT RAISE(ABORT, '${LOCK_MSG}'); END;

    DROP TRIGGER IF EXISTS trg_native_orders_no_update;
    CREATE TRIGGER trg_native_orders_no_update
    BEFORE UPDATE ON native_invoice_orders
    BEGIN SELECT RAISE(ABORT, '${LOCK_MSG}'); END;

    DROP TRIGGER IF EXISTS trg_native_orders_no_delete;
    CREATE TRIGGER trg_native_orders_no_delete
    BEFORE DELETE ON native_invoice_orders
    WHEN (SELECT status FROM native_invoices WHERE id = OLD.invoice_id) = 'issued'
    BEGIN SELECT RAISE(ABORT, '${LOCK_MSG}'); END;

    DROP TRIGGER IF EXISTS trg_native_payments_no_update;
    CREATE TRIGGER trg_native_payments_no_update
    BEFORE UPDATE ON native_payments
    BEGIN SELECT RAISE(ABORT, 'Règlement enregistré : modification interdite. Saisissez une écriture inverse.'); END;

    DROP TRIGGER IF EXISTS trg_native_payments_no_delete;
    CREATE TRIGGER trg_native_payments_no_delete
    BEFORE DELETE ON native_payments
    BEGIN SELECT RAISE(ABORT, 'Règlement enregistré : suppression interdite. Saisissez une écriture inverse.'); END;

    DROP TRIGGER IF EXISTS trg_native_mail_no_update;
    CREATE TRIGGER trg_native_mail_no_update
    BEFORE UPDATE ON native_mail_log
    BEGIN SELECT RAISE(ABORT, 'Historique des envois : modification interdite.'); END;

    DROP TRIGGER IF EXISTS trg_native_mail_no_delete;
    CREATE TRIGGER trg_native_mail_no_delete
    BEFORE DELETE ON native_mail_log
    BEGIN SELECT RAISE(ABORT, 'Historique des envois : suppression interdite.'); END;

    DROP TRIGGER IF EXISTS trg_billing_events_no_update;
    CREATE TRIGGER trg_billing_events_no_update
    BEFORE UPDATE ON billing_events
    BEGIN SELECT RAISE(ABORT, 'Journal de facturation : modification interdite.'); END;

    DROP TRIGGER IF EXISTS trg_billing_events_no_delete;
    CREATE TRIGGER trg_billing_events_no_delete
    BEFORE DELETE ON billing_events
    BEGIN SELECT RAISE(ABORT, 'Journal de facturation : suppression interdite.'); END;
  `);

  // Empreinte d'une ligne de relevé bancaire déjà rapprochée : empêche qu'un même
  // relevé importé deux fois enregistre deux fois le même règlement.
  const payCols = db.prepare("PRAGMA table_info(native_payments)").all().map(c => c.name);
  if (!payCols.includes('bank_fingerprint')) db.exec('ALTER TABLE native_payments ADD COLUMN bank_fingerprint TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_native_payments_bank ON native_payments(bank_fingerprint) WHERE bank_fingerprint IS NOT NULL');

  // Envoi automatique vers Pennylane : date d'activation (NULL = désactivé). Seuls les
  // documents émis APRÈS cette date partent automatiquement, jamais l'historique.
  const setCols = db.prepare('PRAGMA table_info(billing_settings)').all().map(c => c.name);
  if (!setCols.includes('pennylane_auto_since')) db.exec('ALTER TABLE billing_settings ADD COLUMN pennylane_auto_since TEXT');

  // ---------- prélèvements SEPA ----------
  // Identifiant créancier (ICS, délivré par la banque) et délai de préavis donné aux débiteurs.
  if (!setCols.includes('sdd_ics')) db.exec('ALTER TABLE billing_settings ADD COLUMN sdd_ics TEXT');
  if (!setCols.includes('sdd_notice_days')) db.exec('ALTER TABLE billing_settings ADD COLUMN sdd_notice_days INTEGER NOT NULL DEFAULT 14');

  db.exec(`
    -- Mandat de prélèvement : une autorisation signée par un hôtel pour UN compte bancaire.
    -- Jamais supprimé (à conserver 14 mois après le dernier prélèvement) : on le révoque.
    -- Changer de compte = révoquer et créer un nouveau mandat (nouvelle RUM, premier prélèvement « FRST »).
    CREATE TABLE IF NOT EXISTS sdd_mandates (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      umr            TEXT NOT NULL UNIQUE,                   -- référence unique du mandat (RUM), 35 caractères au plus
      scheme         TEXT NOT NULL DEFAULT 'CORE' CHECK (scheme IN ('CORE','B2B')),
      debtor_name    TEXT NOT NULL,
      iban           TEXT NOT NULL,
      bic            TEXT,
      signed_on      TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      revoked_on     TEXT,
      revoked_reason TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sdd_mandates_active ON sdd_mandates(client_id) WHERE status = 'active';

    -- Lot de prélèvements = un fichier pain.008 remis à la banque.
    -- prepared (fichier prêt) → sent (remis à la banque) → settled (encaissé, règlements enregistrés)
    -- ou cancelled. Les coordonnées du créancier sont figées : le fichier se régénère à l'identique.
    CREATE TABLE IF NOT EXISTS sdd_batches (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id           TEXT NOT NULL UNIQUE,
      status           TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','sent','settled','cancelled')),
      collection_date  TEXT NOT NULL,
      creditor_name    TEXT NOT NULL,
      creditor_iban    TEXT NOT NULL,
      creditor_bic     TEXT,
      creditor_ics     TEXT NOT NULL,
      item_count       INTEGER NOT NULL,
      total_cents      INTEGER NOT NULL,
      created_at       TEXT NOT NULL,
      sent_at          TEXT,
      settled_at       TEXT,
      cancelled_at     TEXT,
      cancel_reason    TEXT
    );

    -- Un prélèvement = un mandat = un montant (peut couvrir plusieurs factures du même hôtel).
    CREATE TABLE IF NOT EXISTS sdd_batch_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id       INTEGER NOT NULL REFERENCES sdd_batches(id) ON DELETE RESTRICT,
      mandate_id     INTEGER NOT NULL REFERENCES sdd_mandates(id) ON DELETE RESTRICT,
      seq_type       TEXT NOT NULL CHECK (seq_type IN ('FRST','RCUR')),
      scheme         TEXT NOT NULL CHECK (scheme IN ('CORE','B2B')),
      amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
      end_to_end_id  TEXT NOT NULL,
      remittance     TEXT NOT NULL,
      umr            TEXT NOT NULL,
      signed_on      TEXT NOT NULL,
      debtor_name    TEXT NOT NULL,
      debtor_iban    TEXT NOT NULL,
      debtor_bic     TEXT,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','collected','rejected')),
      reject_reason  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sdd_items_batch ON sdd_batch_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_sdd_items_mandate ON sdd_batch_items(mandate_id);

    CREATE TABLE IF NOT EXISTS sdd_item_invoices (
      item_id       INTEGER NOT NULL REFERENCES sdd_batch_items(id) ON DELETE RESTRICT,
      invoice_id    INTEGER NOT NULL REFERENCES native_invoices(id) ON DELETE RESTRICT,
      amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
      PRIMARY KEY (item_id, invoice_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sdd_item_invoices_invoice ON sdd_item_invoices(invoice_id);

    DROP TRIGGER IF EXISTS trg_sdd_mandates_no_delete;
    CREATE TRIGGER trg_sdd_mandates_no_delete BEFORE DELETE ON sdd_mandates
    BEGIN SELECT RAISE(ABORT, 'Mandat de prélèvement : suppression interdite (à conserver 14 mois). Révoquez-le.'); END;

    DROP TRIGGER IF EXISTS trg_sdd_mandates_no_update;
    CREATE TRIGGER trg_sdd_mandates_no_update BEFORE UPDATE ON sdd_mandates
    WHEN NEW.client_id IS NOT OLD.client_id OR NEW.umr IS NOT OLD.umr OR NEW.scheme IS NOT OLD.scheme
      OR NEW.debtor_name IS NOT OLD.debtor_name OR NEW.iban IS NOT OLD.iban OR NEW.bic IS NOT OLD.bic
      OR NEW.signed_on IS NOT OLD.signed_on OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.status = 'revoked' AND NEW.status <> 'revoked')
    BEGIN SELECT RAISE(ABORT, 'Mandat de prélèvement : modification interdite. Révoquez-le et créez-en un nouveau.'); END;

    DROP TRIGGER IF EXISTS trg_sdd_batches_no_delete;
    CREATE TRIGGER trg_sdd_batches_no_delete BEFORE DELETE ON sdd_batches
    BEGIN SELECT RAISE(ABORT, 'Lot de prélèvements : suppression interdite. Annulez-le.'); END;

    DROP TRIGGER IF EXISTS trg_sdd_batches_no_update;
    CREATE TRIGGER trg_sdd_batches_no_update BEFORE UPDATE ON sdd_batches
    WHEN NEW.msg_id IS NOT OLD.msg_id OR NEW.collection_date IS NOT OLD.collection_date OR NEW.creditor_name IS NOT OLD.creditor_name
      OR NEW.creditor_iban IS NOT OLD.creditor_iban OR NEW.creditor_bic IS NOT OLD.creditor_bic OR NEW.creditor_ics IS NOT OLD.creditor_ics
      OR NEW.item_count IS NOT OLD.item_count OR NEW.total_cents IS NOT OLD.total_cents OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.status IN ('settled','cancelled') AND NEW.status <> OLD.status)
      OR (OLD.status = 'sent' AND NEW.status = 'prepared')
    BEGIN SELECT RAISE(ABORT, 'Lot de prélèvements : modification interdite.'); END;

    DROP TRIGGER IF EXISTS trg_sdd_items_no_delete;
    CREATE TRIGGER trg_sdd_items_no_delete BEFORE DELETE ON sdd_batch_items
    BEGIN SELECT RAISE(ABORT, 'Prélèvement : suppression interdite.'); END;

    DROP TRIGGER IF EXISTS trg_sdd_items_no_update;
    CREATE TRIGGER trg_sdd_items_no_update BEFORE UPDATE ON sdd_batch_items
    WHEN NEW.batch_id IS NOT OLD.batch_id OR NEW.mandate_id IS NOT OLD.mandate_id OR NEW.seq_type IS NOT OLD.seq_type
      OR NEW.scheme IS NOT OLD.scheme OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.end_to_end_id IS NOT OLD.end_to_end_id
      OR NEW.remittance IS NOT OLD.remittance OR NEW.umr IS NOT OLD.umr OR NEW.signed_on IS NOT OLD.signed_on
      OR NEW.debtor_name IS NOT OLD.debtor_name OR NEW.debtor_iban IS NOT OLD.debtor_iban OR NEW.debtor_bic IS NOT OLD.debtor_bic
      OR (OLD.status <> 'pending' AND NEW.status <> OLD.status)
    BEGIN SELECT RAISE(ABORT, 'Prélèvement : modification interdite.'); END;

    DROP TRIGGER IF EXISTS trg_sdd_item_invoices_no_update;
    CREATE TRIGGER trg_sdd_item_invoices_no_update BEFORE UPDATE ON sdd_item_invoices
    BEGIN SELECT RAISE(ABORT, 'Prélèvement : modification interdite.'); END;

    DROP TRIGGER IF EXISTS trg_sdd_item_invoices_no_delete;
    CREATE TRIGGER trg_sdd_item_invoices_no_delete BEFORE DELETE ON sdd_item_invoices
    BEGIN SELECT RAISE(ABORT, 'Prélèvement : suppression interdite.'); END;
  `);

  // ---------- réglages par défaut ----------
  // Ligne unique, créée au premier démarrage. Toute la facturation passe par
  // la facturation intégrée : le circuit Odoo est retiré (l'historique des
  // factures Odoo reste en base et consultable par les hôtels).
  const existing = db.prepare('SELECT id FROM billing_settings WHERE id = 1').get();
  if (!existing) {
    db.prepare(`
      INSERT INTO billing_settings (id, engine, legal_name, legal_form, address_line, postal_code, city, country)
      VALUES (1, 'native', 'BLANCHISSERIE CEZANNE & CO', 'SAS', '153 boulevard Jean-Louis Passet', '84200', 'Carpentras', 'FR')
    `).run();
  }
  db.prepare("UPDATE billing_settings SET engine = 'native' WHERE engine <> 'native'").run();
};
