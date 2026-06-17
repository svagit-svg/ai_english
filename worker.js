const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Telegram helper ──────────────────────────────────────
async function tgSend(botToken, chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return r.json();
}

// ── Reminder messages pool ────────────────────────────────
const REMINDER_MSGS = [
  '🧠 Время английского! Всего 5 минут сегодня — и ты на шаг впереди. Открывай SmartAI English!',
  '📚 Привет! Не забудь про сегодняшний урок. Твой стрик ждёт! 🔥',
  '💬 Пора попрактиковаться в английском! AI-тьютор уже готов к диалогу.',
  '✈️ Один урок сегодня — и завтра будешь говорить свободнее. Давай!',
  '🎯 Ежедневная практика — ключ к успеху. Открывай приложение и занимайся!',
  '⭐ Ты делаешь отличные успехи! Не останавливайся — пройди урок сегодня.',
];

export default {
  // ── HTTP handler ─────────────────────────────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── /notify/subscribe ─────────────────────────────────
    if (path === '/notify/subscribe' && request.method === 'POST') {
      try {
        const { chatId, utcTime, localTime } = await request.json();
        if (!chatId || !utcTime) return json({ error: 'missing fields' }, 400);
        if (!env.REMINDERS) return json({ error: 'KV not configured' }, 500);
        await env.REMINDERS.put(`user:${chatId}`, JSON.stringify({
          chatId: String(chatId),
          utcTime,
          localTime: localTime || utcTime,
          active: true,
          createdAt: new Date().toISOString(),
        }));
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── /notify/unsubscribe ───────────────────────────────
    if (path === '/notify/unsubscribe' && request.method === 'POST') {
      try {
        const { chatId } = await request.json();
        if (!chatId) return json({ error: 'missing chatId' }, 400);
        if (!env.REMINDERS) return json({ error: 'KV not configured' }, 500);
        await env.REMINDERS.delete(`user:${chatId}`);
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── /mistral (AI proxy) ───────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    try {
      const body = await request.json();
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.MISTRAL_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return json({ error: { message: err.message } }, 500);
    }
  },

  // ── Cron: send daily reminders ───────────────────────────
  // Schedule: every hour ("0 * * * *") in wrangler.toml
  async scheduled(event, env, ctx) {
    if (!env.REMINDERS || !env.TG_BOT_TOKEN) return;

    const now = new Date();
    const currentHour = String(now.getUTCHours()).padStart(2, '0');
    const currentMin  = String(now.getUTCMinutes()).padStart(2, '0');
    const currentTime = `${currentHour}:${currentMin}`;

    // List all subscribers
    const list = await env.REMINDERS.list({ prefix: 'user:' });
    const sends = list.keys.map(async ({ name }) => {
      try {
        const raw = await env.REMINDERS.get(name);
        if (!raw) return;
        const user = JSON.parse(raw);
        if (!user.active) return;

        // Match hour (ignore minutes for hourly cron)
        const [uH] = user.utcTime.split(':');
        if (uH !== currentHour) return;

        const msg = REMINDER_MSGS[Math.floor(Math.random() * REMINDER_MSGS.length)];
        await tgSend(env.TG_BOT_TOKEN, user.chatId, msg);
      } catch (_) {}
    });

    ctx.waitUntil(Promise.all(sends));
  },
};
