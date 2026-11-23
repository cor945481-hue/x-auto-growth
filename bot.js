const fs = require('fs');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

async function run() {
  if (!fs.existsSync('config.json')) return;
  const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  let seen = fs.existsSync('seen.json') ? JSON.parse(fs.readFileSync('seen.json', 'utf8')) : [];

  for (const acc of config.accounts) {
    const query = encodeURIComponent(`site:x.com ${acc.niche}`);
    const rssUrl = `https://news.google.com/rss/search?q=${query}+when:1d&hl=fr&gl=FR&ceid=FR:fr`;

    try {
      const res = await fetch(rssUrl);
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g)];

      for (const match of items.slice(0, 3)) {
        const title = match[1].replace(/<!\[CDATA\[|\]\]>/g, '');
        const link = match[2];

        if (seen.includes(link)) continue;
        seen.push(link);

        const comment = await generateMagneticComment(title, acc.niche);
        if (comment) {
          await sendNotification(acc.mainHandle, acc.niche, title, comment, link);
        }
      }
    } catch (err) {
      console.error('Erreur surveillance:', err.message);
    }
  }

  fs.writeFileSync('seen.json', JSON.stringify(seen.slice(-200), null, 2));
}

async function generateMagneticComment(postContent, niche) {
  const prompt = `Tu es un stratège viral sur X (Twitter) en français, spécialisé dans la niche "${niche}".
Un post tendance vient de sortir : "${postContent}"
Rédige UN SEUL commentaire de réponse en français naturel, ultra-tentant, intrigant et percutant (maximum 220 caractères) avec 1 ou 2 emojis tendance.
Objectif : apporter une perspective brillante ou une curiosité irrésistible qui donne immédiatement envie aux lecteurs de cliquer sur mon profil et de s'abonner.
Pas de guillemets, pas d'introduction, donne uniquement le commentaire prêt à coller.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
}

async function sendNotification(account, niche, topic, comment, link) {
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      'Title': `Opportunite X (${niche}) pour ${account}`,
      'Tags': 'fire,rocket'
    },
    body: `Sujet tendance : ${topic}\n\nCOMMENTAIRE PRET A COLLER :\n${comment}\n\nLien : ${link}`
  });
}

run();
