/**
 * Substitua SHEET_ID pela ID da sua Google Sheet
 * Planilha deve ter aba chamada "Convidados" com colunas:
 * Timestamp | nome | telefone | status | mesa
 *
 * Deploy -> Deploy as Web App
 * Execute as: Me
 * Who has access: Anyone (even anonymous)
 */

const SHEET_ID = '19X1TBKHGgermi7f519_9VxbClCsUo1ltjMA55knSNlk';
const SHEET_NAME = 'Convidados';
const LOG_SHEET_NAME = 'Logs';

function doGet(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();
    if (action === 'buscar') return ContentService.createTextOutput(JSON.stringify(buscar(e.parameter.q || ''))).setMimeType(ContentService.MimeType.JSON);
    if (action === 'resumo') return ContentService.createTextOutput(JSON.stringify(getResumo())).setMimeType(ContentService.MimeType.JSON);
    return ContentService.createTextOutput(JSON.stringify({ error: 'missing action' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    logError('doGet', err);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const path = (e.parameter.action || '').toLowerCase();
    const payload = e.postData && e.postData.type === 'application/json' ? JSON.parse(e.postData.contents) : {};
    if (path === 'checkin') {
      const q = payload.q || '';
      return ContentService.createTextOutput(JSON.stringify(postCheckin(q))).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({ error: 'missing action' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    logError('doPost', err);
    return ContentService.createTextOutput(JSON.stringify({ error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

/* ---------- BUSCAR (GET) ---------- */
function buscar(q) {
  q = String(q || '').trim();
  if (!q) return { status: 'error', message: 'Query vazia', results: [] };

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues(); // inclui cabeçalho
  const headers = data.shift().map(h => String(h).toLowerCase().trim());
  const nameIdx = headers.indexOf('nome');
  const telIdx = headers.indexOf('telefone');
  const statusIdx = headers.indexOf('status');
  const mesaIdx = headers.indexOf('mesa');

  const normQ = normalizeString(q);
  const normQTel = normalizePhone(q);

  const results = [];
  data.forEach((row, i) => {
    const nome = String(row[nameIdx] || '');
    const telefone = String(row[telIdx] || '');
    const status = String(row[statusIdx] || '');
    const mesa = String(row[mesaIdx] || '');
    if (nome && normalizeString(nome).indexOf(normQ) !== -1) {
      results.push(buildResult(i + 2, nome, telefone, status, mesa)); // +2: linhas no sheet (1-based, header)
      return;
    }
    if (telefone && normalizePhone(telefone).indexOf(normQTel) !== -1) {
      results.push(buildResult(i + 2, nome, telefone, status, mesa));
      return;
    }
  });

  return { status: 'ok', q: q, count: results.length, results: results };
}

function buildResult(rowNumber, nome, telefone, status, mesa) {
  return { row: rowNumber, nome: nome, telefone: telefone, status: status, mesa: mesa };
}

/* ---------- CHECKIN (POST) ---------- */
function postCheckin(q) {
  q = String(q || '').trim();
  if (!q) return { status: 'error', message: 'Query vazia' };

  const lock = LockService.getScriptLock();
  lock.waitLock(5000); // espera até 5s pelo lock
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    const headers = data.shift().map(h => String(h).toLowerCase().trim());
    const nameIdx = headers.indexOf('nome');
    const telIdx = headers.indexOf('telefone');
    const statusIdx = headers.indexOf('status');
    const mesaIdx = headers.indexOf('mesa');
    const tsIdx = headers.indexOf('timestamp');
    const normQ = normalizeString(q);
    const normQTel = normalizePhone(q);

    // busca primeira correspondência exata/contendo
    let found = null;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const nome = String(row[nameIdx] || '');
      const telefone = String(row[telIdx] || '');
      if ((nome && normalizeString(nome).indexOf(normQ) !== -1) || (telefone && normalizePhone(telefone).indexOf(normQTel) !== -1)) {
        found = { index: i + 2, nome: nome, telefone: telefone, status: String(row[statusIdx] || ''), mesa: String(row[mesaIdx] || '') };
        break;
      }
    }

    if (!found) {
      return { status: 'not_found', message: 'Convite inválido ou não encontrado.' };
    }

    // se já fez check-in
    if ((found.status || '').toLowerCase() === 'checkin' || (found.status || '').toLowerCase() === 'chegado') {
      return { status: 'already', message: 'Convidado já fez check-in.', nome: found.nome, mesa: found.mesa };
    }

    // atualizar status e timestamp
    const rowNumber = found.index;
    const timestamp = new Date();
    const tsCol = tsIdx >= 0 ? tsIdx + 1 : 1; // se Timestamp existe, usa
    // Atualiza cells: Timestamp e Status
    if (tsIdx >= 0) sheet.getRange(rowNumber, tsCol).setValue(timestamp);
    sheet.getRange(rowNumber, statusIdx + 1).setValue('checkin');

    // log
    appendLog({ action: 'checkin', nome: found.nome, telefone: found.telefone, mesa: found.mesa, row: rowNumber, timestamp: timestamp.toISOString() });

    return { status: 'ok', message: 'Convidado confirmado com sucesso!', nome: found.nome, mesa: found.mesa };
  } catch (err) {
    logError('postCheckin', err);
    return { status: 'error', message: err.message };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* ---------- RESUMO (GET) ---------- */
function getResumo() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const headers = data.shift().map(h => String(h).toLowerCase().trim());
  const statusIdx = headers.indexOf('status');
  const nameIdx = headers.indexOf('nome');

  let total = 0;
  let checkins = 0;
  const ultimos = [];

  data.forEach(row => {
    total++;
    const status = String(row[statusIdx] || '').toLowerCase();
    const nome = String(row[nameIdx] || '');
    if (status === 'checkin' || status === 'chegado') {
      checkins++;
      // coletar últimos confirmados a partir do log sheet é mais confiável — but we'll collect here too
      ultimos.push(nome);
    }
  });

  const percent = total === 0 ? 0 : Math.round((checkins / total) * 100);
  // pegar últimos 5
  const lastFive = ultimos.slice(-5).reverse();

  return { status: 'ok', total: total, checkins: checkins, percent: percent, last: lastFive };
}

/* ---------- HELPERS ---------- */
function normalizePhone(tel) {
  return String(tel || '').replace(/\D/g, '');
}
function normalizeString(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function appendLog(obj) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let log;
    if (ss.getSheetByName(LOG_SHEET_NAME)) {
      log = ss.getSheetByName(LOG_SHEET_NAME);
    } else {
      log = ss.insertSheet(LOG_SHEET_NAME);
      log.appendRow(['timestamp','action','nome','telefone','mesa','row','meta']);
    }
    log.appendRow([new Date(), obj.action || '', obj.nome || '', obj.telefone || '', obj.mesa || '', obj.row || '', JSON.stringify(obj.meta || {})]);
  } catch (e) {
    // swallow logging errors
    Logger.log('appendLog error: ' + e);
  }
}

function logError(context, err) {
  try {
    appendLog({ action: 'error:' + context, meta: { message: err.message, stack: err.stack || '' } });
  } catch (e) {
    Logger.log('logError fail: ' + e);
  }
}
