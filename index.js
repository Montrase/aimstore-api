const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors());
app.use(express.json());

// Stockage des clés générées : { key, createdAt, ip }
const keysStore = new Map(); // key -> { createdAt, ip }
const ipToKey = new Map();  // ip -> key

const KEY_DURATION_MS = 24 * 60 * 60 * 1000; // 24 heures

// Génération d'une clé aléatoire sécurisée : AIM-XXXX-XXXX-XXXX
function generateRandomKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const part = () => {
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[crypto.randomInt(chars.length)];
    }
    return s;
  };
  return `AIM-${part()}-${part()}-${part()}`;
}

// Comparaison sécurisée (évite de deviner la clé admin par mesure du temps de réponse)
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// IP du client (première adresse de x-forwarded-for)
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

// 1. Endpoint de génération de clé (appelé par ta page web)
app.get('/api/generate', (req, res) => {
  const clientIp = getClientIp(req);
  const now = Date.now();

  // Vérification d'une clé existante pour cette IP
  if (ipToKey.has(clientIp)) {
    const existingKey = ipToKey.get(clientIp);
    const keyData = keysStore.get(existingKey);

    if (keyData && (now - keyData.createdAt < KEY_DURATION_MS)) {
      const remainingHours = Math.ceil((KEY_DURATION_MS - (now - keyData.createdAt)) / (1000 * 60 * 60));
      return res.json({
        success: true,
        key: existingKey,
        isExisting: true,
        remainingHours: remainingHours,
        message: "Tu as déjà une clé active !"
      });
    } else {
      // Nettoyage de la clé expirée
      keysStore.delete(existingKey);
      ipToKey.delete(clientIp);
    }
  }

  // Génération d'une nouvelle clé si pas de clé active
  const newKey = generateRandomKey();
  keysStore.set(newKey, { createdAt: now, ip: clientIp });
  ipToKey.set(clientIp, newKey);

  res.json({
    success: true,
    key: newKey,
    isExisting: false,
    remainingHours: 24,
    message: "Nouvelle clé générée avec succès !"
  });
});

// 2. Endpoint de vérification (appelé par AimStore Launcher)
app.get('/api/verify', (req, res) => {
  const rawKey = typeof req.query.key === 'string' ? req.query.key.trim() : '';

  if (!rawKey) {
    return res.json({ valid: false, reason: "Clé invalide ou inexistante" });
  }

  // CLÉ ADMIN : stockée uniquement dans la variable d'environnement ADMIN_KEY sur Vercel
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && safeEqual(rawKey, adminKey)) {
    return res.json({
      valid: true,
      isAdmin: true,
      message: "Accès administrateur"
    });
  }

  // CLÉ CLASSIQUE (24h)
  const userKey = rawKey.toUpperCase();

  if (!keysStore.has(userKey)) {
    return res.json({ valid: false, reason: "Clé invalide ou inexistante" });
  }

  const keyData = keysStore.get(userKey);
  const now = Date.now();
  const elapsedTime = now - keyData.createdAt;

  if (elapsedTime > KEY_DURATION_MS) {
    keysStore.delete(userKey);
    if (keyData.ip) ipToKey.delete(keyData.ip);
    return res.json({ valid: false, reason: "Clé expirée (24h dépassées)" });
  }

  const remainingMs = KEY_DURATION_MS - elapsedTime;
  const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));

  return res.json({
    valid: true,
    isAdmin: false,
    message: "Accès autorisé",
    remainingHours: remainingHours,
    expiresIn: remainingMs // le launcher s'arrête exactement à l'expiration réelle de la clé
  });
});

module.exports = app;