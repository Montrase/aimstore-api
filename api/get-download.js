import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // 1. Accepter uniquement les requêtes POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { accessKey, gameId } = req.body;

  // 2. Vérifier que les données sont fournies
  if (!accessKey || !gameId) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    // 3. Vérifier la validité de la clé utilisateur dans Upstash
    // Remplace `key:${accessKey}` si tes clés d'accès sont stockées sous un autre nom dans Redis
    const isKeyValid = await redis.get(`key:${accessKey}`);

    if (!isKeyValid) {
      return res.status(403).json({ error: 'Clé d\'accès invalide ou expirée' });
    }

    // 4. Récupérer les liens secrets des jeux
    const sources = await redis.get('game:sources');

    if (!sources || !sources[gameId]) {
      return res.status(404).json({ error: 'Lien non disponible pour ce jeu' });
    }

    // 5. Renvoi du magnetURI uniquement si la clé d'accès est valide
    return res.status(200).json({ magnetURI: sources[gameId] });

  } catch (error) {
    console.error('Erreur serveur:', error);
    return res.status(500).json({ error: 'Erreur interne du serveur' });
  }
}