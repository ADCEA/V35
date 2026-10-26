// Configuration : coordonnées de l'émetteur, sécurité et sauvegardes, Pennylane, contrôle et exports.
(function () {
  const { e, eur, dFr, dtFr, plural } = Bill;

  // Téléchargement d'un fichier protégé : les erreurs restent affichées dans l'écran (pas de page JSON).
  Bill.download = async function (path, fallbackName) {
    const res = await fetch(Bill.base + path, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = 'Téléchargement impossible.'; let code;
      try { const j = await res.json(); msg = j.error || msg; code = j.code; } catch (_) { /* corps non JSON */ }
      const err = new Error(msg); err.status = res.status; err.data = { code }; if (res.status === 423) { err.locked = true; Bill.showLock(); } throw err;
    }
    const cd = res.headers.get('Content-Disposition') || ''; const m = cd.match(/filename="?([^";]+)"?/);
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : fallbackName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  // ================= Émetteur =================
  const FIELDS = [
    ['Identité', [['legal_name', 'Raison sociale', 'Blanchisserie Cézanne'], ['legal_form', 'Forme juridique', 'SAS'], ['share_capital', 'Capital social', '10 000 €'], ['rcs', 'RCS', 'Avignon B 123 456 789']]],
    ['Immatriculation et TVA', [['siren', 'SIREN', '9 chiffres'], ['siret', 'SIRET du siège', '14 chiffres'], ['vat_number', 'N° de TVA intracommunautaire', 'FR12345678901']]],
    ['Adresse et contact', [['address_line', 'Adresse du siège', ''], ['postal_code', 'Code postal', ''], ['city', 'Ville', ''], ['email', 'E-mail de facturation', ''], ['phone', 'Téléphone', '']]],
    ['Règlement', [['iban', 'IBAN', 'FR76 …'], ['bic', 'BIC', '']]],
  ];

  Bill.register('issuer', {
    async render(main) {
      const { settings: s, hasIssuedDocuments } = await Bill.get('/settings');
      const missing = [];
      if (!s.legal_name) missing.push('raison sociale'); if (!(s.address_line && s.postal_code && s.city)) missing.push('adresse du siège'); if (!s.siren) missing.push('SIREN');
      const advice = [];
      if (!s.vat_number) advice.push('n° de TVA'); if (!s.rcs) advice.push('RCS'); if (!s.share_capital) advice.push('capital social'); if (!s.legal_form) advice.push('forme juridique'); if (!s.iban) advice.push('IBAN');
      main.innerHTML = `<div class="bl-head"><div><h2>Coordonnées de l'émetteur</h2><p>Ces informations figurent sur chaque facture et devis. Elles sont figées sur un document au moment de son émission.</p></div></div>
        ${missing.length ? `<div class="bl-alert bad"><b>Obligatoire pour émettre :</b> ${missing.join(', ')}.</div>` : ''}
        ${!missing.length && advice.length ? `<div class="bl-alert warn"><b>Mentions habituelles à compléter :</b> ${advice.join(', ')}.</div>` : ''}
        <form id="is-form" class="bl-panel"><div class="bl-panel-b">
          ${FIELDS.map(([title, fs]) => `<h3 style="font-family:Fredoka,sans-serif;font-size:15px;margin:6px 0 10px">${title}</h3><div class="bl-row2">${fs.map(([k, label, ph]) => `<div class="bl-field"><label for="is-${k}">${label}</label><input id="is-${k}" name="${k}" value="${e(s[k] || '')}" placeholder="${e(ph)}" ${k === 'iban' || k === 'siren' || k === 'siret' ? 'autocomplete="off"' : ''}></div>`).join('')}</div>`).join('')}
          <h3 style="font-family:Fredoka,sans-serif;font-size:15px;margin:6px 0 10px">Conditions</h3>
          <div class="bl-row3"><div class="bl-field"><label for="is-payment_terms_days">Délai de paiement (jours)</label><input id="is-payment_terms_days" name="payment_terms_days" inputmode="numeric" value="${e(s.payment_terms_days)}"><div class="bl-hint">60 jours au plus (loi).</div></div>
            <div class="bl-field"><label for="is-default_vat_rate">TVA par défaut</label><select id="is-default_vat_rate" name="default_vat_rate">${[20, 10, 5.5, 2.1, 8.5, 0].map(v => `<option value="${v}" ${Number(s.default_vat_rate) === v ? 'selected' : ''}>${String(v).replace('.', ',')} %</option>`).join('')}</select></div>
            <div class="bl-field"><label>Exigibilité de la TVA</label><label class="bl-check" style="margin-top:8px"><input type="checkbox" name="vat_on_debits" ${s.vat_on_debits ? 'checked' : ''}> TVA sur les débits</label></div></div>
          <h3 style="font-family:Fredoka,sans-serif;font-size:15px;margin:14px 0 4px">Escompte pour règlement anticipé</h3>
          <p class="bl-hint" style="margin:0 0 10px">Une remise accordée à l'hôtel qui paie vite. Elle figure sur chaque facture émise ensuite (taux, date limite, montants) et ne change plus après l'émission. Laissez le taux à 0 pour ne rien proposer.</p>
          <div class="bl-row3"><div class="bl-field"><label for="is-early_discount_rate">Taux (%)</label><input id="is-early_discount_rate" name="early_discount_rate" inputmode="decimal" value="${e(String(s.early_discount_rate || 0).replace('.', ','))}" placeholder="1,5"><div class="bl-hint">0 = pas d'escompte. 10 % au plus.</div></div>
            <div class="bl-field"><label for="is-early_discount_hours">Délai (heures)</label><input id="is-early_discount_hours" name="early_discount_hours" inputmode="numeric" value="${e(s.early_discount_hours || 48)}"><div class="bl-hint">À compter de la date d'émission : 48 h = règlement reçu au plus tard 2 jours après.</div></div>
            <div class="bl-field"><label>Hôtels concernés</label><label class="bl-check" style="margin-top:8px"><input type="checkbox" name="early_discount_all" ${s.early_discount_all ? 'checked' : ''}> Tous, par défaut</label><div class="bl-hint">Chaque fiche hôtel peut faire exception (Facturation).</div></div></div>
          <div class="bl-row2"><div class="bl-field"><label for="is-invoice_prefix">Préfixe des factures</label><input id="is-invoice_prefix" name="invoice_prefix" value="${e(s.invoice_prefix)}" ${hasIssuedDocuments ? 'disabled' : ''}></div>
            <div class="bl-field"><label for="is-credit_prefix">Préfixe des avoirs</label><input id="is-credit_prefix" name="credit_prefix" value="${e(s.credit_prefix)}" ${hasIssuedDocuments ? 'disabled' : ''}></div></div>
          ${hasIssuedDocuments ? '<p class="bl-hint" style="margin-top:-6px">Les préfixes sont verrouillés : des documents ont déjà été émis.</p>' : ''}
          <div class="bl-field"><label for="is-late_penalty_text">Mention des pénalités de retard</label><textarea id="is-late_penalty_text" name="late_penalty_text" style="min-height:70px">${e(s.late_penalty_text || '')}</textarea></div>
          <div class="bl-field"><label for="is-footer_note">Note de bas de page (facultatif)</label><input id="is-footer_note" name="footer_note" value="${e(s.footer_note || '')}"></div>
          <div class="bl-err" id="is-err" role="alert"></div>
          <button class="bl-btn primary" type="submit">Enregistrer…</button></div></form>`;
      main.querySelector('#is-form').onsubmit = (ev) => {
        ev.preventDefault();
        const f = ev.target; const body = {};
        for (const el of f.elements) { if (!el.name || el.disabled) continue; body[el.name] = el.type === 'checkbox' ? el.checked : el.value; }
        Bill.sensitive({
          title: 'Enregistrer les coordonnées', scope: 'settings', okLabel: 'Enregistrer',
          text: 'Ces informations (dont l\'IBAN) apparaissent sur toutes les factures. Confirmez avec le code de la Facturation.',
          onSubmit: async () => { await Bill.put('/settings', body); Bill.toast('Coordonnées enregistrées'); Bill.go('issuer'); },
        });
      };
    },
  });

  // ================= Sécurité et sauvegardes =================
  const STATUS = { ok: ['paid', 'Complète'], partial: ['unpaid', 'Partielle'], failed: ['overdue', 'Échec'], running: ['partial', 'En cours'] };
  const sz = (b) => (b == null ? '—' : b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(b / 1024)) + ' Ko');

  async function paintBackups(main) {
    const box = main.querySelector('#sc-bk');
    let s; try { s = await Bill.get('/backup/status'); } catch (err) { return Bill.fail(err, box); }
    const c = s.config;
    const chips = [
      [c.passphraseSet, 'Chiffrement activé', 'Chiffrement absent (BACKUP_PASSPHRASE)'],
      [c.s3.configured, `Stockage externe : ${c.s3.host || ''}${c.s3.bucket ? ' / ' + c.s3.bucket : ''}`, 'Stockage externe non configuré'],
      [c.email.configured, 'Copie par e-mail activée' + (c.email.smtp ? '' : ' (SMTP absent)'), 'Copie par e-mail non configurée'],
      [c.scheduler, 'Sauvegarde automatique chaque nuit', 'Sauvegarde automatique désactivée'],
    ];
    box.innerHTML = `<div class="bl-alert ${s.health === 'ok' ? 'ok' : s.health === 'critical' ? 'bad' : 'warn'}">${e(s.message)}</div>
      <div class="bl-steps">${chips.map(([ok, yes, no]) => `<span class="bl-chip" style="${ok ? 'background:var(--bl-ok-bg);color:var(--bl-ok)' : 'background:var(--bl-wait-bg);color:var(--bl-wait)'}">${e(ok ? yes : no)}</span>`).join('')}</div>
      <div style="margin-bottom:12px"><button class="bl-btn primary" id="bk-run">Sauvegarder maintenant</button></div>
      ${s.runs.length ? `<div class="bl-tablewrap"><table class="bl-table"><thead><tr><th>Date</th><th>Origine</th><th>Résultat</th><th class="r">Taille</th><th>Hors serveur</th><th></th></tr></thead><tbody>
      ${s.runs.map(r => { const st = r.status === 'partial' && !(r.destinations || []).some(d => d.type !== 'local' && !d.ok) ? ['unpaid', 'Sur le serveur seulement'] : (STATUS[r.status] || STATUS.failed); return `<tr><td class="bl-num">${dtFr(r.startedAt)}</td><td>${r.trigger === 'manual' ? 'Manuelle' : 'Automatique'}</td>
        <td><span class="bl-pill ${st[0]}">${st[1]}</span>${r.error ? `<span class="sub" style="color:var(--bl-late)">${e(r.error)}</span>` : ''}</td><td class="r bl-num">${sz(r.sizeBytes)}</td>
        <td>${r.offsiteOk ? `<span class="bl-ind ok">oui · ${e((r.destinations || []).filter(d => d.type !== 'local' && d.ok).map(d => ({ s3: 'stockage externe', email: 'e-mail' }[d.type] || d.type)).join(', '))}</span>` : '<span class="bl-ind">non</span>'}
          ${(r.destinations || []).filter(d => d.type !== 'local' && !d.ok).map(d => `<span class="sub" style="color:var(--bl-late)">${e(({ s3: 'Stockage externe', email: 'E-mail' }[d.type] || d.type) + ' : ' + d.detail)}</span>`).join('')}</td>
        <td class="r">${r.downloadable ? `<button class="bl-btn link small" data-dl="${r.id}">Télécharger</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`
      : '<div class="bl-empty"><b>Aucune sauvegarde pour l\'instant</b>La première se fera cette nuit, ou lancez-la maintenant.</div>'}`;
    box.querySelector('#bk-run').onclick = async (ev) => {
      ev.target.disabled = true; ev.target.textContent = 'Sauvegarde en cours…';
      try {
        const r = await Bill.post('/backup/run'); const last = (r.status_detail && r.status_detail.runs[0]) || { destinations: [] };
        const failedDest = (last.destinations || []).some(d => d.type !== 'local' && !d.ok);
        Bill.toast(r.status === 'ok' ? 'Sauvegarde terminée, copie hors serveur comprise' : r.status === 'partial' ? (failedDest ? 'Sauvegarde faite, mais une copie hors serveur a échoué' : 'Sauvegarde faite sur le serveur seulement : configurez une copie hors serveur') : 'Sauvegarde échouée', r.status === 'failed' || failedDest);
      } catch (err) { Bill.fail(err); }
      Bill.refreshBadges(); paintBackups(main);
    };
    box.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => {
      const id = b.dataset.dl;
      Bill.sensitive({ title: 'Télécharger la sauvegarde', scope: `backup:${id}`, okLabel: 'Télécharger', text: 'La base contient toutes vos données clients et factures. Conservez ce fichier en lieu sûr.', onSubmit: async () => { await Bill.download(`/backup/${id}/download`, 'sauvegarde.sqlite.gz'); } });
    });
  }

  Bill.register('security', {
    async render(main) {
      const mins = Math.round(Bill.state.idleMs / 60000);
      main.innerHTML = `<div class="bl-head"><div><h2>Sécurité et sauvegardes</h2><p>Qui peut ouvrir la Facturation, et comment vos données sont copiées en lieu sûr.</p></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Code de la Facturation</h3></div><div class="bl-panel-b">
          <p class="bl-note">Un code distinct du mot de passe administrateur protège cet espace. Il est redemandé après ${plural(mins, 'minute', 'minutes')} d'inactivité, et à chaque émission de facture ou d'avoir, export comptable, changement de coordonnées bancaires ou téléchargement de sauvegarde. Après 5 erreurs, l'accès est bloqué 15 minutes.</p>
          <div class="bl-actions"><button class="bl-btn" id="sc-change">Changer le code</button><button class="bl-btn" id="sc-lock">Verrouiller maintenant</button></div>
          <p class="bl-hint" style="margin-top:12px">Code oublié ? Sur l'hébergeur (Render), ajoutez la variable <span class="bl-code">BILLING_LOCK_RESET</span> avec une valeur quelconque (changez-la à chaque nouvelle réinitialisation) et redémarrez : le code est effacé et un nouveau vous sera demandé. Aucune donnée n'est perdue.</p></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Sauvegardes</h3></div><div class="bl-panel-b" id="sc-bk"><div class="bl-spin">Chargement…</div></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Mettre en place les copies hors serveur</h3></div><div class="bl-panel-b">
          <p class="bl-note">Une copie sur le disque du serveur ne protège pas d'une perte du serveur lui-même. Pour être réellement à l'abri, il faut une copie ailleurs. Sur l'hébergeur, ajoutez ces variables d'environnement, puis redémarrez :</p>
          <ol class="bl-steplist">
            <li><span class="bl-code">BACKUP_PASSPHRASE</span> : une longue phrase secrète. Elle chiffre chaque copie ; sans elle, rien ne part hors serveur. <b>Gardez-la ailleurs</b> : sans cette phrase, une sauvegarde est illisible.</li>
            <li>Un stockage compatible S3 (Backblaze B2, Cloudflare R2, Scaleway…) : <span class="bl-code">BACKUP_S3_ENDPOINT</span>, <span class="bl-code">BACKUP_S3_BUCKET</span>, <span class="bl-code">BACKUP_S3_REGION</span>, <span class="bl-code">BACKUP_S3_ACCESS_KEY</span>, <span class="bl-code">BACKUP_S3_SECRET_KEY</span>.</li>
            <li>Et/ou un envoi par e-mail : <span class="bl-code">BACKUP_EMAIL_TO</span> (nécessite l'envoi d'e-mails du serveur).</li>
            <li>Facultatif : <span class="bl-code">BACKUP_ALERT_TO</span> pour être prévenu par e-mail si une sauvegarde échoue.</li></ol>
          <p class="bl-hint">Restauration : <span class="bl-code">BACKUP_PASSPHRASE=… node scripts/restore-backup.js fichier.sqlite.gz.enc restauree.sqlite</span>. La procédure complète est décrite dans le fichier README du projet.</p></div></div>`;
      main.querySelector('#sc-lock').onclick = async () => { try { await Bill.post('/lock/lock'); } catch (_) { /* déjà verrouillé */ } Bill.showLock(); };
      main.querySelector('#sc-change').onclick = () => Bill.modal({
        title: 'Changer le code de la Facturation',
        body: `<div class="bl-field"><label for="cc-0">Code actuel</label><input id="cc-0" type="password" autocomplete="off"></div>
          <div class="bl-field"><label for="cc-1">Nouveau code (6 caractères minimum)</label><input id="cc-1" type="password" autocomplete="new-password"></div>
          <div class="bl-field"><label for="cc-2">Nouveau code, une seconde fois</label><input id="cc-2" type="password" autocomplete="new-password"></div>`,
        buttons: [{ label: 'Annuler', onClick: async () => {} }, { label: 'Changer le code', primary: true, onClick: async (m) => {
          await Bill.post('/lock/change', { code: m.$('#cc-0').value, newCode: m.$('#cc-1').value, confirm: m.$('#cc-2').value }); Bill.toast('Code modifié');
        } }],
      });
      await paintBackups(main);
    },
  });

  // ================= Pennylane =================
  async function paintPennylane(main) {
    const box = main.querySelector('#pl-box');
    let s; try { s = await Bill.get('/pennylane/status'); } catch (err) { return Bill.fail(err, box); }
    const c = s.counts;
    box.innerHTML = s.configured ? `
      <div class="bl-panel"><div class="bl-panel-h"><h3>Connexion</h3><button class="bl-btn small" id="pl-test">Tester la connexion</button></div><div class="bl-panel-b">
        <p style="margin:0 0 6px">Jeton d'API présent. Compte relié : <span class="bl-code">${e(s.host)}</span></p><div id="pl-test-res" class="bl-hint"></div></div></div>
      <div class="bl-panel"><div class="bl-panel-h"><h3>Envoi automatique</h3></div><div class="bl-panel-b">
        <p class="bl-note">${s.autoSince ? `Activé depuis le ${dtFr(s.autoSince)}. Chaque nouvelle facture ou avoir émis est transmis à Pennylane dans les minutes qui suivent.` : 'Désactivé. Une fois activé, seuls les documents émis à partir de ce moment sont transmis automatiquement ; les plus anciens restent à envoyer à la main.'}</p>
        <button class="bl-btn ${s.autoSince ? '' : 'primary'}" id="pl-auto">${s.autoSince ? 'Désactiver' : 'Activer l\'envoi automatique'}…</button></div></div>
      <div class="bl-panel"><div class="bl-panel-h"><h3>Suivi des envois</h3></div><div class="bl-figures" style="border-top:none;grid-template-columns:repeat(4,1fr)">
        <div class="bl-figure" style="cursor:default"><span>Transmis</span><b>${c.sent}</b></div><div class="bl-figure" style="cursor:default"><span>En attente</span><b>${c.pending}</b></div>
        <div class="bl-figure" style="cursor:default"><span>En échec</span><b style="${c.error ? 'color:var(--bl-late)' : ''}">${c.error}</b></div><div class="bl-figure" style="cursor:default"><span>Pas encore envoyés</span><b>${c.notQueued}</b></div></div>
        <div class="bl-panel-b" style="border-top:1px solid var(--line)"><div class="bl-actions">${c.notQueued ? `<button class="bl-btn" id="pl-all">Envoyer les ${c.notQueued} documents non transmis</button>` : ''}${c.error ? '<button class="bl-btn" id="pl-retry">Réessayer les échecs</button>' : ''}</div>
        ${s.errors.length ? `<ul class="bl-todo" style="margin-top:12px">${s.errors.map(x => `<li><div class="t">${e(x.number)}<small style="color:var(--bl-late)">${e(x.error || '')}</small></div><button class="bl-btn small" data-open="${x.invoiceId}">Ouvrir</button></li>`).join('')}</ul>` : ''}</div></div>`
      : `<div class="bl-panel"><div class="bl-panel-h"><h3>Relier Pennylane</h3></div><div class="bl-panel-b">
        <p class="bl-note">Votre logiciel reste la source de vérité pour émettre les factures ; Pennylane reçoit une copie pour la comptabilité et le suivi bancaire.</p>
        <ol class="bl-steplist"><li>Dans Pennylane, générez un jeton d'API (accès développeur) avec le droit d'ajouter des factures clients.</li>
        <li>Sur l'hébergeur (Render), ajoutez la variable d'environnement <span class="bl-code">PENNYLANE_API_TOKEN</span> avec ce jeton. Il ne doit jamais être écrit dans le code ni envoyé par message.</li>
        <li>Redémarrez le service, puis revenez sur cette page pour tester la connexion.</li></ol></div></div>`;
    const t = box.querySelector('#pl-test');
    if (t) t.onclick = async () => {
      t.disabled = true; const out = box.querySelector('#pl-test-res'); out.textContent = 'Test en cours…';
      try { const r = await Bill.post('/pennylane/test'); out.innerHTML = r.ok ? '<span class="bl-ok-note">Connexion réussie.</span>' : `<span style="color:var(--bl-late)">Échec : ${e(r.error)}</span>`; } catch (err) { out.textContent = ''; Bill.fail(err); }
      t.disabled = false;
    };
    const au = box.querySelector('#pl-auto');
    if (au) au.onclick = () => Bill.sensitive({
      title: s.autoSince ? "Désactiver l'envoi automatique" : "Activer l'envoi automatique", scope: 'pennylane-auto', okLabel: s.autoSince ? 'Désactiver' : 'Activer',
      text: s.autoSince ? 'Les nouveaux documents ne seront plus transmis automatiquement.' : 'À partir de maintenant, chaque document émis sera transmis à Pennylane. Testez d\'abord la connexion, de préférence sur un compte d\'essai.',
      onSubmit: async () => { await Bill.post('/pennylane/auto', { enabled: !s.autoSince }); Bill.toast(s.autoSince ? 'Envoi automatique désactivé' : 'Envoi automatique activé'); paintPennylane(main); },
    });
    const rt = box.querySelector('#pl-retry'); if (rt) rt.onclick = async () => { try { const r = await Bill.post('/pennylane/retry'); Bill.toast(`${plural(r.requeued, 'envoi remis', 'envois remis')} en file`); setTimeout(() => paintPennylane(main), 1500); } catch (err) { Bill.fail(err); } };
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => Bill.openInvoice(Number(b.dataset.open), () => paintPennylane(main)));
    const all = box.querySelector('#pl-all');
    if (all) all.onclick = async () => {
      all.disabled = true;
      try {
        const list = (await Bill.get('/invoices?tab=all&limit=500&sort=date&dir=asc')).invoices.filter(d => d.status === 'issued' && !d.pennylaneStatus).map(d => d.id);
        let sent = 0; let failed = 0;
        for (let i = 0; i < list.length; i += 20) {
          all.textContent = `Envoi ${Math.min(i + 20, list.length)} / ${list.length}…`;
          const r = await Bill.post('/pennylane/send', { invoiceIds: list.slice(i, i + 20) });
          for (const x of r.results) { if (x.status === 'sent') sent++; else failed++; }
        }
        Bill.toast(`${plural(sent, 'document transmis', 'documents transmis')}${failed ? `, ${failed} en échec` : ''}`, failed > 0 && !sent);
      } catch (err) { Bill.fail(err); }
      paintPennylane(main);
    };
  }

  Bill.register('pennylane', {
    async render(main) {
      main.innerHTML = `<div class="bl-head"><div><h2>Pennylane</h2><p>Transmettez vos factures et avoirs émis à Pennylane pour la comptabilité et le rapprochement bancaire.</p></div></div><div id="pl-box"><div class="bl-spin">Chargement…</div></div>`;
      await paintPennylane(main);
    },
  });

  // ================= Contrôle et FEC =================
  Bill.register('controls', {
    async render(main) {
      const y = new Date().getFullYear();
      main.innerHTML = `<div class="bl-head"><div><h2>Contrôle et exports</h2><p>Vérifiez que rien n'a été altéré, et exportez le fichier des écritures comptables (FEC) pour votre comptable.</p></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Contrôle d'intégrité</h3><button class="bl-btn" id="ct-run">Lancer le contrôle</button></div><div class="bl-panel-b" id="ct-res">
          <p class="bl-note" style="margin:0">Le contrôle revérifie chaque facture émise : empreinte, chaînage entre documents, totaux, continuité de la numérotation et journal des événements.</p></div></div>
        <div class="bl-panel"><div class="bl-panel-h"><h3>Fichier des écritures comptables (FEC)</h3></div><div class="bl-panel-b">
          <div class="bl-row2"><div class="bl-field"><label for="ct-year">Exercice</label><select id="ct-year">${[y, y - 1, y - 2].map(v => `<option value="${v}">${v}</option>`).join('')}</select></div></div>
          <button class="bl-btn primary" id="ct-fec">Télécharger le FEC…</button>
          <p class="bl-hint" style="margin-top:10px">Le FEC reprend les ventes émises (factures et avoirs) et leurs règlements. Il est refusé s'il est déséquilibré.</p></div></div>`;
      main.querySelector('#ct-run').onclick = async (ev) => {
        ev.target.disabled = true; const out = main.querySelector('#ct-res'); out.innerHTML = '<div class="bl-spin" style="padding:6px">Contrôle en cours…</div>';
        try {
          const r = await Bill.get('/integrity');
          out.innerHTML = r.ok ? `<div class="bl-alert ok" style="margin:0"><b>Tout est conforme.</b> ${plural(r.checked, 'document vérifié', 'documents vérifiés')}.</div>`
            : `<div class="bl-alert bad" style="margin:0"><b>${plural(r.problems.length, 'anomalie détectée', 'anomalies détectées')}</b><ul>${r.problems.map(p => `<li>${e(p)}</li>`).join('')}</ul>Ne modifiez rien et contactez votre prestataire avec cette liste.</div>`;
        } catch (err) { out.innerHTML = ''; Bill.fail(err); }
        ev.target.disabled = false;
      };
      main.querySelector('#ct-fec').onclick = () => {
        const year = main.querySelector('#ct-year').value;
        Bill.sensitive({ title: `Exporter le FEC ${year}`, scope: `fec:${year}`, okLabel: 'Télécharger', text: 'Cet export contient l\'ensemble de vos ventes de l\'exercice.', onSubmit: async () => { await Bill.download(`/export/fec?year=${year}`, `FEC${year}.txt`); Bill.toast('FEC téléchargé'); } });
      };
    },
  });
})();
