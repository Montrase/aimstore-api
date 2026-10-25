const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Stockage temporaire des clés
const validKeys = new Map();
const KEY_DURATION_MS = 24 * 60 * 60 * 1000; // 24 heures

function generateRandomKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 6; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `AIM-${randomStr}`;
}

// 1. Générer une clé (à la fin de Linkvertise)
app.get('/api/generate', (req, res) => {
  const newKey = generateRandomKey();
  const now = Date.now();
  validKeys.set(newKey, now);

  res.json({
    success: true,
    key: newKey,
    expiresIn: "24 Hours"
  });
});

// 2. Vérifier la clé (depuis ton Launcher)
app.get('/api/verify', (req, res) => {
  const userKey = req.query.key ? req.query.key.trim().toUpperCase() : '';

  if (!userKey || !validKeys.has(userKey)) {
    return res.json({ valid: false, reason: "Clé invalide" });
  }

  const createdAt = validKeys.get(userKey);
  const now = Date.now();
  const elapsedTime = now - createdAt;

  if (elapsedTime > KEY_DURATION_MS) {
    validKeys.delete(userKey);
    return res.json({ valid: false, reason: "Clé expirée" });
  }

  const remainingHours = Math.round((KEY_DURATION_MS - elapsedTime) / (1000 * 60 * 60));

  return res.json({
    valid: true,
    message: "Accès autorisé",
    remainingHours: remainingHours
  });
});

module.exports = app;