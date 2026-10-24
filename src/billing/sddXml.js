// Fichier de prélèvements SEPA : message ISO 20022 pain.008.001.02 (Customer Direct Debit Initiation),
// la version que les banques françaises acceptent pour les remises de prélèvements SEPA (CORE et B2B).
//
// Fonction pure : le lot (déjà validé et figé en base) entre, le texte XML sort. L'ordre des éléments suit le schéma
// (PmtInf puis DrctDbtTxInf) : une banque refuse un fichier dont l'ordre diffère, même si le contenu est juste.

const R = require('./sddRules');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;

function agent(wrapper, bic) {
  const fin = bic ? tag('BIC', R.normBic(bic)) : '<Othr><Id>NOTPROVIDED</Id></Othr>';
  return `<${wrapper}><FinInstnId>${fin}</FinInstnId></${wrapper}>`;
}

// Ordre fixe des blocs : CORE avant B2B, premier prélèvement (FRST) avant les récurrents (RCUR).
const GROUP_ORDER = ['CORE|FRST', 'CORE|RCUR', 'B2B|FRST', 'B2B|RCUR'];

/**
 * batch : { msgId, createdAt (ISO), collectionDate, creditor: { name, iban, bic, ics } }
 * items : [{ scheme, seqType, endToEndId, amountCents, umr, signedOn, debtorName, debtorIban, debtorBic, remittance }]
 */
function buildPain008(batch, items) {
  if (!items.length) throw new Error('Un fichier de prélèvements ne peut pas être vide.');
  const cr = batch.creditor;
  const total = items.reduce((s, it) => s + it.amountCents, 0);
  const creationTime = new Date(batch.createdAt).toISOString().slice(0, 19);
  const creditorName = R.sepaText(cr.name, 70);

  const groups = new Map(GROUP_ORDER.map(k => [k, []]));
  for (const it of items) {
    const key = `${it.scheme}|${it.seqType}`;
    if (!groups.has(key)) throw new Error(`Type de prélèvement inconnu : ${key}`);
    groups.get(key).push(it);
  }

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">');
  out.push('  <CstmrDrctDbtInitn>');
  out.push('    <GrpHdr>');
  out.push(`      ${tag('MsgId', batch.msgId)}`);
  out.push(`      ${tag('CreDtTm', creationTime)}`);
  out.push(`      ${tag('NbOfTxs', items.length)}`);
  out.push(`      ${tag('CtrlSum', R.amount(total))}`);
  out.push(`      <InitgPty>${tag('Nm', creditorName)}</InitgPty>`);
  out.push('    </GrpHdr>');

  let n = 0;
  for (const [key, list] of groups) {
    if (!list.length) continue;
    n++;
    const [scheme, seq] = key.split('|');
    const sum = list.reduce((s, it) => s + it.amountCents, 0);
    out.push('    <PmtInf>');
    out.push(`      ${tag('PmtInfId', R.sepaId(`${batch.msgId}-${n}`))}`);
    out.push('      <PmtMtd>DD</PmtMtd>');
    out.push('      <BtchBookg>true</BtchBookg>');
    out.push(`      ${tag('NbOfTxs', list.length)}`);
    out.push(`      ${tag('CtrlSum', R.amount(sum))}`);
    out.push(`      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>${scheme}</Cd></LclInstrm><SeqTp>${seq}</SeqTp></PmtTpInf>`);
    out.push(`      ${tag('ReqdColltnDt', batch.collectionDate)}`);
    out.push(`      <Cdtr>${tag('Nm', creditorName)}</Cdtr>`);
    out.push(`      <CdtrAcct><Id>${tag('IBAN', R.normIban(cr.iban))}</Id></CdtrAcct>`);
    out.push(`      ${agent('CdtrAgt', cr.bic)}`);
    out.push('      <ChrgBr>SLEV</ChrgBr>');
    out.push(`      <CdtrSchmeId><Id><PrvtId><Othr>${tag('Id', R.normIcs(cr.ics))}<SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>`);
    for (const it of list) {
      out.push('      <DrctDbtTxInf>');
      out.push(`        <PmtId>${tag('EndToEndId', R.sepaId(it.endToEndId))}</PmtId>`);
      out.push(`        <InstdAmt Ccy="EUR">${R.amount(it.amountCents)}</InstdAmt>`);
      out.push(`        <DrctDbtTx><MndtRltdInf>${tag('MndtId', it.umr)}${tag('DtOfSgntr', it.signedOn)}</MndtRltdInf></DrctDbtTx>`);
      out.push(`        ${agent('DbtrAgt', it.debtorBic)}`);
      out.push(`        <Dbtr>${tag('Nm', R.sepaText(it.debtorName, 70))}</Dbtr>`);
      out.push(`        <DbtrAcct><Id>${tag('IBAN', R.normIban(it.debtorIban))}</Id></DbtrAcct>`);
      out.push(`        <RmtInf>${tag('Ustrd', R.sepaText(it.remittance, 140))}</RmtInf>`);
      out.push('      </DrctDbtTxInf>');
    }
    out.push('    </PmtInf>');
  }
  out.push('  </CstmrDrctDbtInitn>');
  out.push('</Document>');
  return out.join('\n') + '\n';
}

module.exports = { buildPain008 };
