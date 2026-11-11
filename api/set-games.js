import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  try {
    // Les liens de tes jeux associés à leur ID
    const gamesData = {
      "1": "magnet:?xt=urn:btih:TON_LIEN_NARUTO",
      "2": "magnet:?xt=urn:btih:TON_LIEN_DRAGONBALL",
      "3": "magnet:?xt=urn:btih:TON_LIEN_FC27",
      "4": "magnet:?xt=urn:btih:TON_LIEN_FORZA6",
      "5": "magnet:?xt=urn:btih:TON_LIEN_MW4",
      "6": "magnet:?xt=urn:btih:TON_LIEN_ROOFTOP",
      "8": "magnet:?xt=urn:btih:TON_LIEN_GTA_SA",
      "10": "magnet:?xt=urn:btih:TON_LIEN_GTA_V",
      "11": "magnet:?xt=urn:btih:TON_LIEN_CYBERPUNK",
      "12": "magnet:?xt=urn:btih:TON_LIEN_RDR2",
      "14": "magnet:?xt=urn:btih:TON_LIEN_SPIDERMAN2",
      "15": "magnet:?xt=urn:btih:TON_LIEN_GTA_IV",
      "16": "magnet:?xt=urn:btih:TON_LIEN_MW2",
      "17": "magnet:?xt=urn:btih:TON_LIEN_007",
      "18": "magnet:?xt=urn:btih:TON_LIEN_WUKONG",
      "22": "magnet:?xt=urn:btih:TON_LIEN_MW3",
      "23": "magnet:?xt=urn:btih:TON_LIEN_GENESIS",
      "24": "magnet:?xt=urn:btih:TON_LIEN_FC25",
      "25": "magnet:?xt=urn:btih:TON_LIEN_SHADOWS"
    };

    // Enregistrement dans Upstash Redis
    await redis.set('game:sources', gamesData);

    return res.status(200).json({ success: true, message: "Les liens sont enregistrés dans Redis !" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}