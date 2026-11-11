import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Même API que celle utilisée par le launcher pour contrôler la session (home.html)
const CHECK_URL = 'https://aimstore-api.vercel.app/api/check';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // 1. POST uniquement
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const body = req.body || {};
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const gameId = body.gameId !== undefined && body.gameId !== null ? String(body.gameId).trim() : '';

  // 2. Données obligatoires, de taille raisonnable
  if (!token || !gameId || token.length > 5000 || gameId.length > 50) {
    return res.status(400).json({ error: 'Paramètres manquants ou invalides' });
  }

  try {
    // 3. Le jeton de session doit être authentique et la clé encore valable
    //    (on réutilise exactement la même vérification que le reste du launcher :
    //     elle gère les clés de 24h, la clé admin et l'expiration)
    const check = await fetch(CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });

    if (check.status === 429) {
      return res.status(429).json({ error: 'Trop de demandes' });
    }

    const session = await check.json().catch(() => null);
    if (!session || session.valid !== true) {
      return res.status(403).json({ error: 'Session invalide ou expirée' });
    }

    // 4. Source du jeu
    const sources = await redis.get('game:sources');
    if (!sources || !sources[gameId]) {
      return res.status(404).json({ error: 'Lien non disponible pour ce jeu' });
    }

    // 5. Renvoi de la source seulement si la session est valide
    return res.status(200).json({ magnetURI: sources[gameId] });
  } catch (error) {
    console.error('Erreur serveur:', error);
    return res.status(500).json({ error: 'Erreur interne du serveur' });
  }
}