const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// Base de données Redis (Upstash) : lit automatiquement les variables d'environnement
// ajoutées par Vercel quand tu connectes la base au projet.
const redis = Redis.fromEnv();

const KEY_TTL_SEC = 24 * 60 * 60;          // une clé dure 24 heures
const KEY_DURATION_MS = KEY_TTL_SEC * 1000;
const SESSION_TTL_SEC = 2 * 60 * 60;       // une session de checkpoints dure 2 heures

const SID_RE = /^[a-f0-9]{48}$/;
const KEY_RE = /^AIM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const WORKINK_TOKEN_RE = /^[A-Za-z0-9-]{20,64}$/;
const LINKVERTISE_HASH_RE = /^[A-Za-z0-9]{32,128}$/;

/* ----------------------------- Utilitaires ----------------------------- */

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const part = () => {
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[crypto.randomInt(chars.length)];
    return s;
  };
  return `AIM-${part()}-${part()}-${part()}`;
}

// Limiteur de requêtes par IP (protège contre les essais en boucle).
// Si Redis est indisponible, on laisse passer pour ne pas bloquer les vrais utilisateurs.
async function rateLimit(name, ip, max, windowSec) {
  try {
    const k = `rl:${name}:${ip}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowSec);
    if (n > max) {
      const ttl = await redis.ttl(k);
      if (ttl === -1) await redis.expire(k, windowSec);
    }
    return n <= max;
  } catch (e) {
    return true;
  }
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || 8000);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------- Vérification des checkpoints --------------------- */

// Work.ink : le jeton est vérifié côté serveur et supprimé après usage (usage unique).
// On contrôle aussi que le jeton vient bien de TON lien (WORKINK_LINK_ID),
// sinon quelqu'un pourrait créer son propre lien Work.ink facile et obtenir un jeton valide.
let lastWorkinkReason = '';

async function verifyWorkink(token) {
  lastWorkinkReason = '';
  if (!WORKINK_TOKEN_RE.test(token)) {
    lastWorkinkReason = 'jeton au mauvais format';
    console.error(`[workink] ${lastWorkinkReason}`);
    return false;
  }
  const r = await fetchWithTimeout(
    `https://work.ink/_api/v2/token/isValid/${encodeURIComponent(token)}?deleteToken=1`
  );
  if (!r.ok) {
    lastWorkinkReason = `work.ink a répondu HTTP ${r.status}`;
    console.error(`[workink] ${lastWorkinkReason}`);
    return false;
  }
  const data = await r.json();
  if (data.valid !== true) {
    lastWorkinkReason = 'jeton refusé par work.ink (déjà utilisé, expiré ou invalide)';
    console.error(`[workink] ${lastWorkinkReason}`);
    return false;
  }

  const receivedLinkId = data.info && data.info.linkId;
  const expectedLinkId = process.env.WORKINK_LINK_ID;
  if (!expectedLinkId) {
    lastWorkinkReason = `WORKINK_LINK_ID non défini, linkId reçu : ${receivedLinkId}`;
    console.error(`[workink] ${lastWorkinkReason}`);
    return false;
  }
  if (String(receivedLinkId) !== String(expectedLinkId)) {
    lastWorkinkReason = `linkId différent : reçu ${receivedLinkId}, attendu ${expectedLinkId}`;
    console.error(`[workink] ${lastWorkinkReason}`);
    return false;
  }
  return true;
}

// Linkvertise Anti-Bypass : le "hash" est valable 10 secondes et ne peut être vérifié qu'une seule fois.
let lastLinkvertiseReason = '';

async function verifyLinkvertise(hash) {
  lastLinkvertiseReason = '';
  const token = (process.env.LINKVERTISE_AB_TOKEN || '').trim();
  if (!token) {
    lastLinkvertiseReason = 'LINKVERTISE_AB_TOKEN non défini dans Vercel';
    console.error(`[linkvertise] ${lastLinkvertiseReason}`);
    return false;
  }
  if (!LINKVERTISE_HASH_RE.test(hash)) {
    lastLinkvertiseReason = `hash au mauvais format (${hash.length} caractères)`;
    console.error(`[linkvertise] ${lastLinkvertiseReason}`);
    return false;
  }
  const url = `https://publisher.linkvertise.com/api/v1/anti_bypassing?token=${encodeURIComponent(token)}&hash=${encodeURIComponent(hash)}`;
  const r = await fetchWithTimeout(url, { method: 'POST' });
  const text = (await r.text()).trim().replace(/"/g, '').toUpperCase();
  if (text !== 'TRUE') {
    lastLinkvertiseReason = `Linkvertise a répondu HTTP ${r.status} : ${text.slice(0, 80)}`;
    console.warn(`[linkvertise] ${lastLinkvertiseReason}`);
    return false;
  }
  return true;
}

/* ------------------------------ Clés (24h) ------------------------------ */

// Une seule clé active par IP. Si l'IP en a déjà une, on la renvoie.
async function issueKey(ip) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await redis.get(`ip:${ip}`);
    if (existing) {
      const rec = await redis.get(`key:${existing}`);
      if (rec) return { key: existing, isExisting: true };
      await redis.del(`ip:${ip}`);
    }

    const key = generateKey();
    const created = await redis.set(`key:${key}`, { createdAt: Date.now(), ip: ip }, { ex: KEY_TTL_SEC, nx: true });
    if (!created) continue; // collision de clé (quasi impossible) : on recommence

    const claimed = await redis.set(`ip:${ip}`, key, { nx: true, ex: KEY_TTL_SEC });
    if (claimed) return { key, isExisting: false };

    await redis.del(`key:${key}`); // une autre requête a gagné la course : on annule la nôtre
  }
  throw new Error('Impossible de créer la clé');
}

async function buildState(sid, session) {
  if (session.step >= 2 && session.key) {
    const rec = await redis.get(`key:${session.key}`);
    const remainingMs = rec ? rec.createdAt + KEY_DURATION_MS - Date.now() : 0;
    if (remainingMs > 0) {
      return {
        step: 2,
        key: session.key,
        isExisting: !!session.isExisting,
        remainingHours: Math.ceil(remainingMs / 3600000)
      };
    }
    // La clé a expiré pendant la session : on repart de zéro
    await redis.set(`sess:${sid}`, { step: 0, createdAt: Date.now() }, { ex: SESSION_TTL_SEC });
    return { step: 0 };
  }
  return { step: session.step || 0 };
}

/* -------------------------------- Routes -------------------------------- */

// 1. Créer ou reprendre une session de checkpoints
app.post('/api/session', async (req, res) => {
  const ip = getClientIp(req);
  if (!(await rateLimit('session', ip, 30, 60))) {
    return res.status(429).json({ success: false, message: 'Trop de requêtes, réessaie dans une minute.' });
  }
  try {
    let sid = req.body && typeof req.body.sid === 'string' ? req.body.sid : '';
    let session = SID_RE.test(sid) ? await redis.get(`sess:${sid}`) : null;

    if (!session) {
      sid = crypto.randomBytes(24).toString('hex');
      session = { step: 0, createdAt: Date.now() };
      await redis.set(`sess:${sid}`, session, { ex: SESSION_TTL_SEC });
    }
    const state = await buildState(sid, session);
    return res.json(Object.assign({ success: true, sid }, state));
  } catch (e) {
    console.error('[session]', e);
    return res.status(503).json({ success: false, message: 'Service temporairement indisponible.' });
  }
});

// 2. Valider un checkpoint (Work.ink puis Linkvertise, dans cet ordre)
app.post('/api/checkpoint', async (req, res) => {
  const ip = getClientIp(req);
  if (!(await rateLimit('checkpoint', ip, 20, 60))) {
    return res.status(429).json({ success: false, message: 'Trop de tentatives, réessaie dans une minute.' });
  }

  const body = req.body || {};
  const sid = body.sid;
  const provider = body.provider;
  const hash = body.hash;

  if (typeof sid !== 'string' || !SID_RE.test(sid) ||
      (provider !== 'workink' && provider !== 'linkvertise') ||
      typeof hash !== 'string' || hash.length > 200) {
    return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'Requête invalide.' });
  }

  try {
    const sessKey = `sess:${sid}`;
    const session = await redis.get(sessKey);
    if (!session) {
      return res.status(400).json({ success: false, code: 'NO_SESSION', message: 'Session expirée. Recommence depuis le checkpoint #1.' });
    }

    if (session.step >= 2) {
      return res.json(Object.assign({ success: true, sid }, await buildState(sid, session)));
    }

    const expected = session.step === 0 ? 'workink' : 'linkvertise';
    if (provider !== expected) {
      return res.status(400).json({
        success: false,
        code: 'WRONG_ORDER',
        message: expected === 'workink'
          ? "Commence par le checkpoint #1."
          : "Le checkpoint #1 est déjà validé, passe au #2."
      });
    }

    let ok = false;
    try {
      ok = provider === 'workink' ? await verifyWorkink(hash) : await verifyLinkvertise(hash);
    } catch (e) {
      console.error('[checkpoint] service de vérification injoignable', e);
      return res.status(502).json({ success: false, code: 'PROVIDER_ERROR', message: 'Service de vérification injoignable. Réessaie le checkpoint.' });
    }

    if (!ok) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_PROOF',
        message: 'Vérification échouée. Refais le checkpoint depuis le début.' +
          (process.env.DEBUG_CHECKPOINT === '1' ? ' [debug : ' + (provider === 'workink' ? lastWorkinkReason : lastLinkvertiseReason) + ']' : '')
      });
    }

    if (provider === 'workink') {
      session.step = 1;
    } else {
      const issued = await issueKey(ip);
      session.step = 2;
      session.key = issued.key;
      session.isExisting = issued.isExisting;
    }
    await redis.set(sessKey, session, { ex: SESSION_TTL_SEC });

    return res.json(Object.assign({ success: true, sid }, await buildState(sid, session)));
  } catch (e) {
    console.error('[checkpoint]', e);
    return res.status(503).json({ success: false, message: 'Service temporairement indisponible.' });
  }
});

// 3. Vérification de clé (appelée par AimStore Launcher) : GET (actuel) ou POST
async function handleVerify(req, res) {
  const ip = getClientIp(req);
  if (!(await rateLimit('verify', ip, 30, 60))) {
    return res.status(429).json({ valid: false, rateLimited: true, reason: 'Trop de tentatives. Réessaie dans une minute.' });
  }

  const input = req.method === 'POST' ? (req.body && req.body.key) : req.query.key;
  const rawKey = typeof input === 'string' ? input.trim() : '';
  if (!rawKey || rawKey.length > 128) {
    return res.json({ valid: false, reason: 'Clé invalide ou inexistante' });
  }

  // Clé admin : uniquement dans la variable d'environnement ADMIN_KEY (Vercel)
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && safeEqual(rawKey, adminKey)) {
    return res.json({ valid: true, isAdmin: true, message: 'Accès administrateur' });
  }

  try {
    const userKey = rawKey.toUpperCase();
    if (!KEY_RE.test(userKey)) {
      return res.json({ valid: false, reason: 'Clé invalide ou inexistante' });
    }

    const rec = await redis.get(`key:${userKey}`);
    if (!rec) {
      return res.json({ valid: false, reason: 'Clé invalide ou expirée' });
    }

    const remainingMs = rec.createdAt + KEY_DURATION_MS - Date.now();
    if (remainingMs <= 0) {
      await redis.del(`key:${userKey}`);
      return res.json({ valid: false, reason: 'Clé expirée (24h dépassées)' });
    }

    return res.json({
      valid: true,
      isAdmin: false,
      message: 'Accès autorisé',
      remainingHours: Math.ceil(remainingMs / 3600000),
      expiresIn: remainingMs
    });
  } catch (e) {
    console.error('[verify]', e);
    return res.status(503).json({ valid: false, reason: 'Service temporairement indisponible.' });
  }
}
app.get('/api/verify', handleVerify);
app.post('/api/verify', handleVerify);

// 4. L'ancien endpoint est désactivé : il permettait d'obtenir une clé sans passer les checkpoints
app.all('/api/generate', (req, res) => {
  res.status(410).json({ success: false, message: 'Endpoint supprimé.' });
});

// 5. DIAGNOSTIC TEMPORAIRE : teste le token Linkvertise avec un faux hash (ne consomme aucun vrai essai).
// Actif uniquement quand la variable DEBUG_CHECKPOINT vaut 1. À désactiver ensuite.
app.get('/api/debug-linkvertise', async (req, res) => {
  if (process.env.DEBUG_CHECKPOINT !== '1') return res.status(404).json({ success: false });
  const ip = getClientIp(req);
  if (!(await rateLimit('debuglv', ip, 5, 60))) return res.status(429).json({ success: false });
  const token = (process.env.LINKVERTISE_AB_TOKEN || '').trim();
  if (!token) return res.json({ tokenDefini: false });
  try {
    const fake = 'a'.repeat(64);
    const r = await fetchWithTimeout(
      `https://publisher.linkvertise.com/api/v1/anti_bypassing?token=${encodeURIComponent(token)}&hash=${fake}`,
      { method: 'POST' }
    );
    const text = (await r.text()).trim();
    return res.json({ tokenDefini: true, longueurToken: token.length, httpStatus: r.status, reponseLinkvertise: text.slice(0, 120) });
  } catch (e) {
    return res.json({ tokenDefini: true, longueurToken: token.length, erreur: String(e.message || e) });
  }
});

// Erreurs de requête (JSON invalide, trop gros, etc.)
app.use((err, req, res, next) => {
  res.status(400).json({ success: false, message: 'Requête invalide.' });
});

module.exports = app;
