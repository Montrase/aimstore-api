const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Stockage des clés générées : { key, createdAt, ip }
const keysStore = new Map(); // key -> { createdAt, ip }
const ipToKey = new Map();  // ip -> key

const KEY_DURATION_MS = 24 * 60 * 60 * 1000; // 24 heures

function generateRandomKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 6; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `AIM-${randomStr}`;
}

// 1. Endpoint sécurisé de génération de clé (Appelé uniquement par ta page web)
app.get('/api/generate', (req, res) => {
  // Récupérer l'IP de l'utilisateur
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const now = Date.now();

  // 🛡️ SÉCURITÉ 1 : Vérification d'une clé existante pour cette IP
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

// 2. Endpoint de vérification (Appelé par AimStore Launcher)
app.get('/api/verify', (req, res) => {
  const userKey = req.query.key ? req.query.key.trim().toUpperCase() : '';

  if (!userKey || !keysStore.has(userKey)) {
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

  const remainingHours = Math.ceil((KEY_DURATION_MS - elapsedTime) / (1000 * 60 * 60));

  return res.json({
    valid: true,
    message: "Accès autorisé",
    remainingHours: remainingHours
  });
});

module.exports = app;