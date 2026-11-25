import fs from "fs";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const ACCOUNTS_FILE = "./watched_accounts.json";
const SEEN_FILE = "./seen_posts.json";

function loadJson(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

async function sendNtfy(title, message, clickUrl = "") {
  if (!NTFY_TOPIC) return;
  const headers = {
    "Title": title,
    "Priority": "high"
  };
  if (clickUrl) headers["Click"] = clickUrl;

  await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers,
    body: message
  });
}

async function generateEmojiReply(handle, postText) {
  const prompt = `Un compte suivi (@${handle}) vient de publier ce post :
"${postText}"

Génère un commentaire court (moins de 180 caractères), naturel et percutant, en correspondance directe avec le sujet exact de ce post, avec des emojis pertinents.
Règles strictes :
- Ne mentionne JAMAIS "mon profil", "fais un tour sur mon profil", "regarde mon compte" ou tout appel à visiter le profil.
- Donne uniquement le commentaire prêt à copier-coller, sans introduction ni explication.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function fetchLatestPost(handle) {
  const clean = handle.replace(/^@/, "").trim();

  // Source 1 : Syndication publique X (timeline intégrable)
  try {
    const res = await fetch(
      `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(clean)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html"
        }
      }
    );
    if (res.ok) {
      const html = await res.text();
      const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        const entries = parsed?.props?.pageProps?.timeline?.entries || [];
        const tweets = entries
          .filter(e => e.type === "tweet" && e.content?.tweet)
          .map(e => e.content.tweet);

        if (tweets.length > 0) {
          tweets.sort((a, b) => (BigInt(b.id_str) > BigInt(a.id_str) ? 1 : -1));
          const latest = tweets[0];
          const postId = latest.id_str;
          const text = (latest.full_text || latest.text || "").replace(/\s+/g, " ").trim();
          return {
            id: postId,
            text,
            url: `https://x.com/${clean}/status/${postId}`
          };
        }
      }
    }
  } catch (err) {
    console.log(`Erreur syndication pour @${clean} :`, err.message);
  }

  // Source 2 : Repli RSS si disponible
  const sources = [
    `https://xcancel.com/${encodeURIComponent(clean)}/rss`,
    `https://nitter.net/${encodeURIComponent(clean)}/rss`
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const xml = await res.text();
      const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/);
      if (!itemMatch) continue;

      const item = itemMatch[1];
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const titleMatch =
        item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
        item.match(/<title>([\s\S]*?)<\/title>/);

      if (linkMatch && titleMatch) {
        const rawLink = linkMatch[1].trim();
        const idMatch = rawLink.match(/status\/(\d+)/);
        const postId = idMatch ? idMatch[1] : rawLink;
        return {
          id: postId,
          text: titleMatch[1].replace(/<[^>]+>/g, "").trim(),
          url: `https://x.com/${clean}/status/${postId}`
        };
      }
    } catch {
      // Passe à la source suivante
    }
  }

  return null;
}

async function run() {
  const accounts = loadJson(ACCOUNTS_FILE, []);
  if (!Array.isArray(accounts) || accounts.length === 0) {
    console.log("Aucun compte suivi dans watched_accounts.json");
    return;
  }

  const seen = loadJson(SEEN_FILE, {});
  let changed = false;

  for (const handle of accounts) {
    const clean = handle.replace(/^@/, "").trim();
    if (!clean) continue;

    const latest = await fetchLatestPost(clean);
    if (!latest) {
      console.log(`Impossible de lire @${clean} pour le moment.`);
      continue;
    }

    if (seen[clean] === latest.id) {
      console.log(`Rien de nouveau pour @${clean}`);
      continue;
    }

    seen[clean] = latest.id;
    changed = true;

    const reply = await generateEmojiReply(clean, latest.text);
    const body = `Post : ${latest.text}\n\nCommentaire prêt :\n${reply}`;
    await sendNtfy(`Nouveau post de @${clean}`, body, latest.url);
    console.log(`Notification envoyée pour @${clean}`);
  }

  if (changed) {
    saveJson(SEEN_FILE, seen);
  }
}

run();
