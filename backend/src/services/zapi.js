/**
 * Serviço Z-API — comunicação centralizada com WhatsApp.
 * A documentação oficial usa base https://api.z-api.io e paths
 * /instances/{instanceId}/token/{token}/...
 */

const { pool } = require('../config/db');

async function getCreds(apiInstanceId = null) {
  try {
    let q = `SELECT * FROM api_instances WHERE is_active = true`;
    const params = [];
    if (apiInstanceId) {
      q += ` AND id = $1`;
      params.push(apiInstanceId);
    }
    q += ` ORDER BY id DESC LIMIT 1`;
    const { rows } = await pool.query(q, params);
    if (rows[0]) {
      return {
        id: rows[0].id,
        name: rows[0].name,
        provider: rows[0].provider || 'Z-API',
        instance_id: rows[0].instance_id,
        token: rows[0].token,
        client_token: rows[0].client_token || '',
        webhook_url: rows[0].webhook_url,
      };
    }
  } catch {
    // migration 003/004 pode ainda não ter sido aplicada
  }

  const { rows } = await pool.query('SELECT * FROM zapi_config ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

function zapiBase(creds) {
  return `https://api.z-api.io/instances/${creds.instance_id}/token/${creds.token}`;
}

function zapiHeaders(creds, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extra,
  };
  if (creds.client_token) headers['Client-Token'] = creds.client_token;
  return headers;
}

async function zapiJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function zapiRequest(creds, endpoint, options = {}) {
  const res = await fetch(`${zapiBase(creds)}${endpoint}`, {
    ...options,
    headers: zapiHeaders(creds, options.headers || {}),
  });
  const data = await zapiJson(res);
  if (!res.ok) {
    const msg = data?.error || data?.message || data?.raw || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

async function checkStatus(creds) {
  return zapiRequest(creds, '/status', { method: 'GET' });
}

async function registerWebhook(creds, webhookUrl) {
  await zapiRequest(creds, '/update-webhook-received', {
    method: 'PUT',
    body: JSON.stringify({ value: webhookUrl }),
  });

  // Diferentes contas/documentações podem usar nomes distintos. Mantemos tentativas não fatais.
  await zapiRequest(creds, '/update-webhook-message-status', {
    method: 'PUT',
    body: JSON.stringify({ value: webhookUrl }),
  }).catch(() => {});

  await zapiRequest(creds, '/update-webhook-delivery', {
    method: 'PUT',
    body: JSON.stringify({ value: webhookUrl }),
  }).catch(() => {});

  return true;
}

async function fetchContact(creds, phone) {
  const endpoints = [
    `/contacts/${phone}`,
    `/get-metadata-contact?phone=${encodeURIComponent(phone)}`,
    `/get-profile-picture?phone=${encodeURIComponent(phone)}`,
  ];
  let out = {};
  for (const ep of endpoints) {
    try {
      const d = await zapiRequest(creds, ep, { method: 'GET' });
      out = { ...out, ...d };
    } catch {}
  }
  return {
    name: out.name || out.notify || out.short || out.pushName || null,
    photo: out.imgUrl || out.profilePictureUrl || out.picture || out.url || null,
    raw: out,
  };
}

async function sendText(creds, phone, message) {
  return zapiRequest(creds, '/send-text', {
    method: 'POST',
    body: JSON.stringify({ phone, message, delayTyping: 1 }),
  });
}

async function sendImage(creds, phone, imageBase64, caption = '') {
  return zapiRequest(creds, '/send-image', {
    method: 'POST',
    body: JSON.stringify({ phone, image: imageBase64, caption, delayTyping: 1 }),
  });
}

async function sendVideo(creds, phone, videoBase64, caption = '') {
  return zapiRequest(creds, '/send-video', {
    method: 'POST',
    body: JSON.stringify({ phone, video: videoBase64, caption }),
  });
}

async function sendAudio(creds, phone, audioBase64) {
  return zapiRequest(creds, '/send-audio', {
    method: 'POST',
    body: JSON.stringify({ phone, audio: audioBase64, waveform: true }),
  });
}

async function sendSticker(creds, phone, stickerBase64) {
  return zapiRequest(creds, '/send-sticker', {
    method: 'POST',
    body: JSON.stringify({ phone, sticker: stickerBase64 }),
  });
}

async function sendDocument(creds, phone, documentBase64, fileName = 'documento.pdf', caption = '') {
  const ext = (fileName.split('.').pop() || 'pdf').toLowerCase();
  return zapiRequest(creds, `/send-document/${encodeURIComponent(ext)}`, {
    method: 'POST',
    body: JSON.stringify({ phone, document: documentBase64, fileName, caption }),
  });
}

function normalizePhone(raw) {
  return String(raw || '').split('@')[0].replace(/\D/g, '');
}

function isLid(raw) {
  const s = String(raw || '');
  if (s.includes('@lid')) return true;
  const digits = normalizePhone(s);
  return digits.length > 13;
}

function realPhoneCandidate(v) {
  const d = normalizePhone(v);
  if (!d) return null;
  if (d.length >= 10 && d.length <= 13 && !isLid(v)) return d;
  return null;
}

function getAliases(payload = {}) {
  const values = [
    payload.phone,
    payload.senderLid,
    payload.chatLid,
    payload.participantPhone,
    payload.from,
    payload.to,
    payload.remoteJid,
    payload.key?.remoteJid,
    payload.key?.participant,
  ].filter(Boolean);

  const out = [];
  for (const v of values) {
    const raw = String(v);
    const digits = normalizePhone(raw);
    if (raw && !out.find(x => x.alias === raw)) out.push({ alias: raw, type: raw.includes('@lid') ? 'lid' : 'raw' });
    if (digits && !out.find(x => x.alias === digits)) out.push({ alias: digits, type: isLid(raw) ? 'lid_digits' : 'phone' });
  }
  return out;
}

function resolvePhone(payload = {}) {
  const candidates = [
    payload.phone,
    payload.participantPhone,
    payload.from,
    payload.to,
    payload.remoteJid,
    payload.key?.remoteJid,
  ];
  for (const c of candidates) {
    const d = realPhoneCandidate(c);
    if (d) return d;
  }
  // fallback para LID/dígitos; será resolvido por alias no backend
  return normalizePhone(payload.phone || payload.senderLid || payload.chatLid || payload.remoteJid || '');
}

function mapStatus(s) {
  if (!s) return null;
  s = String(s).toUpperCase();
  if (s === 'READ' || s === 'PLAYED') return 'READ';
  if (['RECEIVED','DELIVERED','DELIVERY_ACK','DEVICE_ACK'].includes(s)) return 'RECEIVED';
  if (['SENT','SERVER_ACK'].includes(s)) return 'SENT';
  if (['PENDING','PENDING_ACK'].includes(s)) return 'PENDING';
  return null;
}

async function findApiInstanceFromPayload(payload = {}) {
  const possible = payload.instanceId || payload.instance_id || payload.instance || payload.instanceID || null;
  try {
    if (possible) {
      const { rows } = await pool.query(
        `SELECT * FROM api_instances
         WHERE is_active = true AND instance_id = $1
         ORDER BY id DESC LIMIT 1`,
        [String(possible)]
      );
      if (rows[0]) return rows[0];
    }

    const { rows } = await pool.query(
      `SELECT * FROM api_instances WHERE is_active = true ORDER BY id ASC LIMIT 1`
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}


async function registerEveryWebhook(creds, webhookUrl) {
  try {
    return await zapiRequest(creds, '/update-every-webhooks', {
      method: 'PUT',
      body: JSON.stringify({
        value: webhookUrl,
        notifySentByMe: true,
      }),
    });
  } catch (err) {
    // Fallback para contas/documentações que usam configuração por evento.
    await registerWebhook(creds, webhookUrl);
    return { ok: true, fallback: true };
  }
}

module.exports = {
  getCreds,
  zapiBase,
  zapiHeaders,
  checkStatus,
  registerWebhook,
  registerEveryWebhook,
  fetchContact,
  sendText,
  sendImage,
  sendVideo,
  sendAudio,
  sendSticker,
  sendDocument,
  normalizePhone,
  isLid,
  getAliases,
  resolvePhone,
  mapStatus,
  findApiInstanceFromPayload,
};
