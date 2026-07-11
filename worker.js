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

// ── D1 user sync (#31) ────────────────────────────────────
// Достаёт telegram user из initData — поле "user" покрыто HMAC-хэшем,
// поэтому доверять ему можно только ПОСЛЕ verifyInitData().
function extractTgUser(initData) {
  try {
    const params = new URLSearchParams(initData);
    const raw = params.get('user');
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u || !u.id) return null;
    return { id: u.id, username: u.username || '', firstName: u.first_name || '' };
  } catch (e) {
    return null;
  }
}

// В отличие от requireTgAuth — НЕ fail-open. Спуфинг initData здесь даёт доступ
// к чужой строке в БД, а не только к своему платежу — риск другого масштаба.
async function requireTgUser(request, env) {
  if (!env.TG_BOT_TOKEN) return { error: json({ error: 'sync not configured' }, 503) };
  const initData = request.headers.get('X-Telegram-Init-Data');
  const ok = await verifyInitData(initData, env.TG_BOT_TOKEN);
  if (!ok) return { error: json({ error: 'unauthorized' }, 401) };
  const u = extractTgUser(initData);
  if (!u) return { error: json({ error: 'no user in initData' }, 400) };
  return { user: u };
}

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// Мёржит текущую строку из D1 (или дефолтную "пустую" для нового пользователя)
// с локальным снапшотом клиента. Каждое правило монотонно (union/max) — сервер
// никогда не теряет данные, независимо от порядка/частоты вызовов с разных устройств.
function mergeUser(existing, incoming, verifiedUser, now) {
  const ex = existing || {
    xp: 0, lessons: 0, dialogs: 0, streak: 0, last_date: '',
    daily_activity: '{}', history: '[]', course_progress: '{}',
    vocab: '[]', mistakes: '[]', achievements: '[]', freezes: '{}', dc_streak: '{}',
    pro: 0, pro_until: 0, trial_start: 0, onboarded: 0, level: '', goal: '', reminder_time: '',
    created_at: now,
  };
  const inStats = incoming.stats || {};
  const merged = { telegram_id: verifiedUser.id, created_at: ex.created_at || now, updated_at: now };

  merged.username = verifiedUser.username;
  merged.first_name = verifiedUser.firstName;

  // stats: заменяем всей пятёркой, только если incoming.xp строго больше — как в CloudStorage-мёрже
  const incomingXp = inStats.xp || 0;
  if (incomingXp > (ex.xp || 0)) {
    merged.xp = incomingXp;
    merged.lessons = inStats.lessons || 0;
    merged.dialogs = inStats.dialogs || 0;
    merged.streak = inStats.streak || 0;
    merged.last_date = inStats.lastDate || '';

    const exActivity = safeParse(ex.daily_activity, {});
    const cutoff = new Date(now - 60 * 864e5).toISOString().slice(0, 10);
    const mergedActivity = {};
    Object.entries(Object.assign({}, exActivity, inStats.dailyActivity || {})).forEach(([k, v]) => {
      if (k >= cutoff) mergedActivity[k] = v;
    });
    merged.daily_activity = JSON.stringify(mergedActivity);

    const exHistory = safeParse(ex.history, []);
    const inHistory = (inStats.history || []).map(h => ({ date: h.date, topic: h.topic, msgs: h.msgs || 0 }));
    const seen = new Set();
    merged.history = JSON.stringify(
      [...exHistory, ...inHistory]
        .filter(h => { const k = h.date + '|' + h.topic; if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(-50)
    );
  } else {
    merged.xp = ex.xp || 0;
    merged.lessons = ex.lessons || 0;
    merged.dialogs = ex.dialogs || 0;
    merged.streak = ex.streak || 0;
    merged.last_date = ex.last_date || '';
    merged.daily_activity = ex.daily_activity;
    merged.history = ex.history;
  }

  // course_progress: union по courseId→lessonId — существующий урок никогда не затирается,
  // только добавляются недостающие (совпадает с текущей клиентской логикой)
  const exCourses = safeParse(ex.course_progress, {});
  const inCourses = incoming.courseProgress || {};
  const mergedCourses = {};
  new Set([...Object.keys(exCourses), ...Object.keys(inCourses)]).forEach(cid => {
    const mergedLessons = Object.assign({}, exCourses[cid] || {});
    Object.entries(inCourses[cid] || {}).forEach(([lid, val]) => {
      if (!mergedLessons[lid]) mergedLessons[lid] = val;
    });
    mergedCourses[cid] = mergedLessons;
  });
  merged.course_progress = JSON.stringify(mergedCourses);

  // vocab: union, дедуп по phrase, последние 200
  const vocabMap = new Map();
  [...safeParse(ex.vocab, []), ...(incoming.vocab || [])].forEach(v => { if (v && v.phrase) vocabMap.set(v.phrase, v); });
  merged.vocab = JSON.stringify(Array.from(vocabMap.values()).slice(-200));

  // mistakes: union, дедуп по q (новее ts побеждает), кап 50
  const mistakeMap = new Map();
  [...safeParse(ex.mistakes, []), ...(incoming.mistakes || [])].forEach(m => {
    if (!m || !m.q) return;
    const cur = mistakeMap.get(m.q);
    if (!cur || (m.ts || 0) > (cur.ts || 0)) mistakeMap.set(m.q, m);
  });
  merged.mistakes = JSON.stringify(Array.from(mistakeMap.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 50));

  // achievements: union id — раз получено на любом устройстве, видно на всех
  merged.achievements = JSON.stringify(Array.from(new Set([...safeParse(ex.achievements, []), ...(incoming.achievements || [])])));

  // freezes/dc_streak/onboarding-поля: incoming перезаписывает — это уже самый свежий локальный снапшот на момент пуша
  merged.freezes = JSON.stringify(incoming.freezes || safeParse(ex.freezes, {}));
  merged.dc_streak = JSON.stringify(incoming.dcStreak || safeParse(ex.dc_streak, {}));
  merged.trial_start = incoming.trialStart != null ? incoming.trialStart : (ex.trial_start || 0);
  merged.onboarded = incoming.onboarded ? 1 : (ex.onboarded || 0);
  merged.level = incoming.level != null ? incoming.level : (ex.level || '');
  merged.goal = incoming.goal != null ? incoming.goal : (ex.goal || '');
  merged.reminder_time = incoming.reminderTime != null ? incoming.reminderTime : (ex.reminder_time || '');

  // pro/pro_until: побеждает активная подписка с более поздним сроком (атомарно на сервере)
  const exActive = ex.pro === 1 && (!ex.pro_until || ex.pro_until > now);
  const inActive = !!incoming.pro && (!incoming.proUntil || incoming.proUntil > now);
  if (inActive && (!exActive || (incoming.proUntil || 0) > (ex.pro_until || 0))) {
    merged.pro = 1;
    merged.pro_until = incoming.proUntil || 0;
  } else if (exActive) {
    merged.pro = 1;
    merged.pro_until = ex.pro_until || 0;
  } else {
    merged.pro = 0;
    merged.pro_until = 0;
  }

  return merged;
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

    // ── /sync (#31) ─────────────────────────────────────────
    // Push+pull за один round-trip: клиент шлёт снапшот, сервер мёржит в D1
    // (union/max, никогда не разрушающе) и возвращает смёрженную строку.
    if (path === '/sync' && request.method === 'POST') {
      const auth = await requireTgUser(request, env);
      if (auth.error) return auth.error;
      if (!env.DB) return json({ error: 'D1 not configured' }, 500);
      try {
        const bodyText = await request.text();
        if (bodyText.length > 300000) return json({ error: 'payload too large' }, 413);
        const body = JSON.parse(bodyText);

        const existing = await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?1').bind(auth.user.id).first();
        const now = Date.now();
        const merged = mergeUser(existing, body, auth.user, now);

        await env.DB.prepare(`
          INSERT INTO users (telegram_id, username, first_name, xp, lessons, dialogs, streak, last_date,
            daily_activity, history, course_progress, vocab, mistakes, achievements, freezes, dc_streak,
            pro, pro_until, trial_start, onboarded, level, goal, reminder_time, created_at, updated_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)
          ON CONFLICT(telegram_id) DO UPDATE SET
            username=excluded.username, first_name=excluded.first_name,
            xp=excluded.xp, lessons=excluded.lessons, dialogs=excluded.dialogs,
            streak=excluded.streak, last_date=excluded.last_date,
            daily_activity=excluded.daily_activity, history=excluded.history,
            course_progress=excluded.course_progress, vocab=excluded.vocab,
            mistakes=excluded.mistakes, achievements=excluded.achievements,
            freezes=excluded.freezes, dc_streak=excluded.dc_streak,
            pro=excluded.pro, pro_until=excluded.pro_until, trial_start=excluded.trial_start,
            onboarded=excluded.onboarded, level=excluded.level, goal=excluded.goal,
            reminder_time=excluded.reminder_time, updated_at=excluded.updated_at
        `).bind(
          merged.telegram_id, merged.username, merged.first_name,
          merged.xp, merged.lessons, merged.dialogs, merged.streak, merged.last_date,
          merged.daily_activity, merged.history, merged.course_progress, merged.vocab,
          merged.mistakes, merged.achievements, merged.freezes, merged.dc_streak,
          merged.pro, merged.pro_until, merged.trial_start, merged.onboarded,
          merged.level, merged.goal, merged.reminder_time,
          merged.created_at, merged.updated_at
        ).run();

        return json({ ok: true, user: merged });
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
