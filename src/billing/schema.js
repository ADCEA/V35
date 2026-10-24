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

    DROP TRIGGER IF EXISTS trg_billing_events_no_update;
    CREATE TRIGGER trg_billing_events_no_update
    BEFORE UPDATE ON billing_events
    BEGIN SELECT RAISE(ABORT, 'Journal de facturation : modification interdite.'); END;

    DROP TRIGGER IF EXISTS trg_billing_events_no_delete;
    CREATE TRIGGER trg_billing_events_no_delete
    BEFORE DELETE ON billing_events
    BEGIN SELECT RAISE(ABORT, 'Journal de facturation : suppression interdite.'); END;
  `);

  // ---------- réglages par défaut ----------
  // Ligne unique, créée au premier démarrage. Moteur : on garde Odoo tant
  // qu'il est configuré sur le serveur (aucun changement de comportement
  // pour l'existant), sinon la facturation intégrée prend le relais.
  const existing = db.prepare('SELECT id FROM billing_settings WHERE id = 1').get();
  if (!existing) {
    const odooConfigured = Boolean(process.env.ODOO_URL && process.env.ODOO_API_KEY);
    db.prepare(`
      INSERT INTO billing_settings (id, engine, legal_name, legal_form, address_line, postal_code, city, country)
      VALUES (1, ?, 'BLANCHISSERIE CEZANNE & CO', 'SAS', '153 boulevard Jean-Louis Passet', '84200', 'Carpentras', 'FR')
    `).run(odooConfigured ? 'odoo' : 'native');
  }
};
