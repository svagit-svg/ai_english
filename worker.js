const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, X-Telegram-Init-Data',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Telegram initData verification (#34) ─────────────────
// Проверяет HMAC-подпись initData бот-токеном (Telegram WebApp spec).
async function hmacSha256(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  try {
    const enc = new TextEncoder();
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    // data_check_string: все поля кроме hash, отсортированы, key=value через \n
    const pairs = [];
    for (const [k, v] of params) { if (k !== 'hash') pairs.push(`${k}=${v}`); }
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    // secret_key = HMAC(key="WebAppData", msg=botToken); hash = HMAC(key=secret_key, msg=dcs)
    const secretKey = await hmacSha256(enc.encode('WebAppData'), enc.encode(botToken));
    const computed = await hmacSha256(secretKey, enc.encode(dataCheckString));
    const computedHex = [...computed].map(b => b.toString(16).padStart(2, '0')).join('');
    // сравнение без утечки по времени
    if (computedHex.length !== hash.length) return false;
    let diff = 0;
    for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ hash.charCodeAt(i);
    return diff === 0;
  } catch (e) {
    return false;
  }
}

// Гейт для защищённых эндпоинтов. Возвращает null если ОК, либо Response(401).
// Fail-open: если TG_BOT_TOKEN не задан — пропускаем (не ломаем прод до настройки).
async function requireTgAuth(request, env) {
  if (!env.TG_BOT_TOKEN) return null; // защита ещё не включена
  const initData = request.headers.get('X-Telegram-Init-Data');
  const ok = await verifyInitData(initData, env.TG_BOT_TOKEN);
  if (!ok) return json({ error: 'unauthorized' }, 401);
  return null;
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

// ── Premium plans (YooKassa direct) ──────────────────────
// Суммы в рублях. Должны совпадать с ценами в index.html.
const PLANS = {
  week:  { amount: '99.00',   days: 7,   desc: 'SmartAI English Premium — Неделя' },
  month: { amount: '299.00',  days: 30,  desc: 'SmartAI English Premium — Месяц' },
  year:  { amount: '1999.00', days: 365, desc: 'SmartAI English Premium — Год' },
};

// Basic-auth заголовок для YooKassa API из секретов Worker
function yooAuth(env) {
  return 'Basic ' + btoa(`${env.YOOKASSA_SHOP_ID}:${env.YOOKASSA_SECRET_KEY}`);
}

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

    // ── /pay/create ───────────────────────────────────────
    // Создаёт платёж в YooKassa, возвращает { paymentId, url }
    if (path === '/pay/create' && request.method === 'POST') {
      try {
        const authErr = await requireTgAuth(request, env);
        if (authErr) return authErr;
        if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) {
          return json({ error: 'payments not configured' }, 503);
        }
        const { plan } = await request.json();
        const p = PLANS[plan];
        if (!p) return json({ error: 'bad plan' }, 400);
        const r = await fetch('https://api.yookassa.ru/v3/payments', {
          method: 'POST',
          headers: {
            'Authorization': yooAuth(env),
            'Idempotence-Key': crypto.randomUUID(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: { value: p.amount, currency: 'RUB' },
            capture: true,
            confirmation: { type: 'redirect', return_url: env.PAY_RETURN_URL || 'https://t.me' },
            description: p.desc,
            metadata: { plan },
          }),
        });
        const data = await r.json();
        if (data.confirmation && data.confirmation.confirmation_url) {
          return json({ paymentId: data.id, url: data.confirmation.confirmation_url });
        }
        return json({ error: 'yookassa error', detail: data }, 502);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── /pay/status ───────────────────────────────────────
    // Проверяет статус платежа напрямую в YooKassa: { status, paid }
    if (path === '/pay/status' && request.method === 'POST') {
      try {
        const authErr = await requireTgAuth(request, env);
        if (authErr) return authErr;
        if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) {
          return json({ error: 'payments not configured' }, 503);
        }
        const { paymentId } = await request.json();
        if (!paymentId) return json({ error: 'missing paymentId' }, 400);
        const r = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
          headers: { 'Authorization': yooAuth(env) },
        });
        const data = await r.json();
        return json({ status: data.status || 'unknown', paid: data.paid === true, plan: data.metadata && data.metadata.plan });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── /mistral (AI proxy) ───────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    const mistralAuthErr = await requireTgAuth(request, env);
    if (mistralAuthErr) return mistralAuthErr;

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
