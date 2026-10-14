import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import { Telegraf } from "telegraf";
import crypto from "crypto";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// --- Config ---
const PORT = process.env.PORT || 3000;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID?.trim();
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET?.trim();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();

// Render автоматически предоставляет RENDER_EXTERNAL_URL, используем его как запасной вариант!
const RAW_APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
const APP_URL = RAW_APP_URL ? RAW_APP_URL.trim().replace(/\/$/, "") : null;
const WEBHOOK_SECRET = (process.env.TWITCH_WEBHOOK_SECRET || "super_secret_key_123").trim();

// Настройки для GitHub Gist
const GIST_ID = process.env.GIST_ID?.trim();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
const GIST_FILENAME = "streamers.json";

// --- State & Storage ---
let monitoredStreamers = [];
let appAccessToken = null;
let isBotActive = true;
const processedMessages = new Set(); // Защита от повторной отправки одного и того же вебхука

async function loadStreamers() {
  if (!GIST_ID || !GITHUB_TOKEN) {
    console.warn("⚠️ GIST_ID или GITHUB_TOKEN не заданы! Список хранится только в памяти.");
    return;
  }
  try {
    const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });
    const file = res.data.files[GIST_FILENAME];
    if (file && file.content) {
      const parsed = JSON.parse(file.content);
      monitoredStreamers = parsed.map(s => ({
        ...s,
        record: s.record ?? true,
        quality: s.quality ?? "best",
        lastTitle: s.lastTitle ?? null,
        lastCategory: s.lastCategory ?? null
      }));
      console.log(`📂 Загружено стримеров из Gist: ${monitoredStreamers.length}`);
    } else {
      monitoredStreamers = [];
      await saveStreamers();
    }
  } catch (err) {
    console.error("❌ Ошибка загрузки из Gist:", err.response?.data?.message || err.message);
    monitoredStreamers = [];
  }
}

async function saveStreamers() {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    await axios.patch(
      `https://api.github.com/gists/${GIST_ID}`,
      {
        files: {
          [GIST_FILENAME]: {
            content: JSON.stringify(monitoredStreamers, null, 2),
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
  } catch (err) {
    console.error("❌ Ошибка сохранения в Gist:", err.response?.data?.message || err.message);
  }
}

// --- Telegram Bot ---
const bot = TELEGRAM_BOT_TOKEN ? new Telegraf(TELEGRAM_BOT_TOKEN) : null;
if (bot) {
  bot.start((ctx) => ctx.reply("🚀 Instant Stream Monitor is ACTIVE!\n\nUse /id to get your Chat ID."));
  
  bot.command("id", (ctx) => {
    ctx.reply(`🆔 Your Chat ID is: ${ctx.chat.id}`);
  });

  bot.command("add", async (ctx) => {
    const login = ctx.message.text.split(" ")[1];
    if (!login) return ctx.reply("❌ Usage: /add username");
    const res = await addStreamer(login);
    if (res.error) return ctx.reply(`❌ ${res.error}`);
    await saveStreamers();
    ctx.reply(`✅ Added ${login}. Notifications are ON, PC Recording is OFF by default. Use /record ${login} to enable recording.`);
  });

  bot.command("remove", async (ctx) => {
    const login = ctx.message.text.split(" ")[1]?.toLowerCase();
    const index = monitoredStreamers.findIndex(s => s.login.toLowerCase() === login);
    if (index === -1) return ctx.reply("❌ Not found.");
    
    const streamer = monitoredStreamers[index];
    monitoredStreamers.splice(index, 1);
    await saveStreamers();
    
    await unsubscribeFromEventSub(streamer.id);
    ctx.reply(`✅ Removed ${login} and deleted Twitch subscriptions.`);
  });

  bot.command("record", async (ctx) => {
    const login = ctx.message.text.split(" ")[1]?.toLowerCase();
    if (!login) return ctx.reply("❌ Usage: /record username");
    
    const streamer = monitoredStreamers.find(s => s.login.toLowerCase() === login);
    if (!streamer) return ctx.reply("❌ Not found.");
    
    streamer.record = !streamer.record;
    await saveStreamers();
    
    ctx.reply(`🔴 PC Recording for ${streamer.login} is now ${streamer.record ? 'ON' : 'OFF'}.`);
  });

  const VALID_QUALITIES = ["1080p", "720p", "480p", "audio_only", "best"];
  const QUALITY_LABELS = {
    "best":       "Best available quality (falls back to audio_only)",
    "1080p":      "1080p (falls back to audio_only if unavailable)",
    "720p":       "720p (falls back to audio_only if unavailable)",
    "480p":       "480p (falls back to audio_only if unavailable)",
    "audio_only": "Audio only",
  };

  bot.command("quality", async (ctx) => {
    const parts = ctx.message.text.split(" ");
    const login = parts[1]?.toLowerCase();
    const quality = parts[2]?.toLowerCase();

    if (!login || !quality) {
      return ctx.reply(
        "❌ Usage: /quality username <quality>\n\n" +
        "Available qualities:\n" +
        "• best — Best video (falls back to audio_only)\n" +
        "• 1080p — 1080p video (falls back to audio_only)\n" +
        "• 720p — 720p video (falls back to audio_only)\n" +
        "• 480p — 480p video (falls back to audio_only)\n" +
        "• audio_only — Audio only"
      );
    }

    if (!VALID_QUALITIES.includes(quality)) {
      return ctx.reply(
        `❌ Invalid quality "${quality}".\n\nAvailable options:\n` +
        Object.entries(QUALITY_LABELS).map(([k, v]) => `• ${k} — ${v}`).join("\n")
      );
    }

    const streamer = monitoredStreamers.find(s => s.login.toLowerCase() === login);
    if (!streamer) return ctx.reply("❌ Not found.");

    streamer.quality = quality;
    await saveStreamers();

    ctx.reply(`🎥 Recording quality for ${streamer.login} set to: ${quality}\n\n${QUALITY_LABELS[quality]}`);
  });

  // НОВАЯ КОМАНДА: Проверка статуса вебхуков прямо из Telegram!
  bot.command("webhooks", async (ctx) => {
    if (!appAccessToken) await getAppAccessToken();
    try {
      const subsRes = await axios.get("https://api.twitch.tv/helix/eventsub/subscriptions", {
        headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` }
      });
      const subs = subsRes.data.data;
      if (subs.length === 0) {
        return ctx.reply(`⚠️ Вебхуков нет!\nТекущий APP_URL: ${APP_URL || "НЕ ЗАДАН"}`);
      }
      const summary = subs.map(s => {
        const st = monitoredStreamers.find(m => m.id === s.condition.broadcaster_user_id);
        const name = st ? st.login : s.condition.broadcaster_user_id;
        return `• ${name}: ${s.type} (v${s.version}) — [${s.status}]`;
      }).join("\n");
      ctx.reply(`📡 Активные вебхуки (${subs.length}):\nURL: ${APP_URL}\n\n${summary}`);
    } catch (err) {
      ctx.reply(`❌ Ошибка проверки вебхуков: ${err.message}`);
    }
  });

  bot.command("commands", (ctx) => {
    ctx.reply(
      "📖 Available Commands:\n\n" +
      "/add <username> — Add a streamer to monitor\n" +
      "/remove <username> — Remove a streamer\n" +
      "/list — Show all monitored streamers with status\n" +
      "/record <username> — Toggle PC recording on/off\n" +
      "/quality <username> <quality> — Set recording quality\n" +
      "/webhooks — Check Twitch EventSub status\n" +
      "/id — Get your Telegram Chat ID\n" +
      "/commands — Show this help message"
    );
  });

  bot.command("list", (ctx) => {
    const list = monitoredStreamers.map(s => 
      `• ${s.login} (${s.status}) [Record: ${s.record ? 'ON' : 'OFF'}] [Quality: ${s.quality ?? 'best'}]`
    ).join("\n");
    ctx.reply(`📋 List:\n${list || "Empty"}`);
  });
}

async function startBot() {
  if (!bot) return;
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log("✅ Telegram Bot launched!");
  } catch (err) {
    if (err.message?.includes("409")) {
      console.warn("⚠️ Bot Conflict: Another instance is running.");
      isBotActive = false;
    } else {
      console.error("❌ Bot launch error:", err.message);
    }
  }
}

process.once("SIGINT", () => bot && isBotActive && bot.stop("SIGINT"));
process.once("SIGTERM", () => bot && isBotActive && bot.stop("SIGTERM"));

// --- Twitch Logic ---
async function getAppAccessToken() {
  try {
    const res = await axios.post("https://id.twitch.tv/oauth2/token", null, {
      params: { client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: "client_credentials" },
    });
    appAccessToken = res.data.access_token;
    return appAccessToken;
  } catch (err) {
    console.error("❌ Twitch Token Error:", err.response?.data || err.message);
    return null;
  }
}

async function addStreamer(login) {
  if (!appAccessToken) await getAppAccessToken();
  try {
    const res = await axios.get(`https://api.twitch.tv/helix/users?login=${login.toLowerCase()}`, {
      headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` },
    });
    if (res.data.data.length === 0) return { error: "User not found" };
    const user = res.data.data[0];
    
    const streamer = { id: user.id, login: user.login, status: "offline", record: false, quality: "best" };
    
    if (!monitoredStreamers.find(s => s.id === user.id)) {
      monitoredStreamers.push(streamer);
      await syncEventSub();
    }
    return streamer;
  } catch (err) {
    if (err.response?.status === 401) await getAppAccessToken();
    return { error: err.message };
  }
}

async function unsubscribeFromEventSub(userId) {
  if (!appAccessToken) await getAppAccessToken();
  try {
    const subsRes = await axios.get("https://api.twitch.tv/helix/eventsub/subscriptions", {
      headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` }
    });
    const userSubs = subsRes.data.data.filter(s => s.condition.broadcaster_user_id === userId);
    for (const sub of userSubs) {
      await axios.delete(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, {
        headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` }
      });
      console.log(`🗑️ Deleted sub: ${sub.type} for user ${userId}`);
    }
  } catch (err) {
    console.error(`❌ Unsubscribe Error: ${err.message}`);
  }
}

// ИСПРАВЛЕНО: У каждого события своя актуальная версия по стандарту Twitch API
const EVENTSUB_TYPES = [
  { type: "stream.online", version: "1" },
  { type: "stream.offline", version: "1" },
  { type: "channel.update", version: "2" }, // Версия 2 обязательна!
];

async function syncEventSub() {
  if (!APP_URL) {
    console.warn("⚠️ APP_URL не задан! Вебхуки Twitch EventSub НЕ могут быть зарегистрированы.");
    return;
  }
  if (!appAccessToken) await getAppAccessToken();
  const callbackUrl = `${APP_URL}/api/twitch/webhook`;
  
  try {
    const subsRes = await axios.get("https://api.twitch.tv/helix/eventsub/subscriptions", {
      headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` }
    });
    
    const existingSubs = subsRes.data.data;
    console.log(`📡 Twitch has ${existingSubs.length} active subscriptions. Target callback: ${callbackUrl}`);

    for (const sub of existingSubs) {
      const isWrongUrl = sub.transport.callback !== callbackUrl;
      const isFailed = sub.status !== "enabled" && sub.status !== "webhook_callback_verification_pending";
      const isOrphaned = !monitoredStreamers.find(s => s.id === sub.condition.broadcaster_user_id);
      const isOldVersion = sub.type === "channel.update" && sub.version !== "2";
      
      if (isWrongUrl || isFailed || isOrphaned || isOldVersion) {
        let reason = isWrongUrl ? "URL Mismatch" : (isFailed ? `Status: ${sub.status}` : (isOldVersion ? "Old v1" : "Orphaned"));
        console.log(`🗑️ Deleting invalid sub: ${sub.type} (Reason: ${reason})`);
        await axios.delete(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, {
          headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` }
        }).catch(() => {});
      }
    }

    for (const streamer of monitoredStreamers) {
      for (const { type, version } of EVENTSUB_TYPES) {
        const alreadyExists = existingSubs.find(s => 
          s.type === type && 
          s.version === version &&
          s.condition.broadcaster_user_id === streamer.id &&
          s.transport.callback === callbackUrl &&
          (s.status === "enabled" || s.status === "webhook_callback_verification_pending")
        );

        if (!alreadyExists) {
          try {
            await axios.post("https://api.twitch.tv/helix/eventsub/subscriptions", {
              type,
              version,
              condition: { broadcaster_user_id: streamer.id },
              transport: { method: "webhook", callback: callbackUrl, secret: WEBHOOK_SECRET }
            }, { headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` } });
            console.log(`✅ Subscribed: ${type} (v${version}) for ${streamer.login}`);
          } catch (err) {
            if (err.response?.status === 409) {
              console.log(`ℹ️ ${type} for ${streamer.login} already exists.`);
            } else {
              console.error(`❌ Sub Error (${type} for ${streamer.login}):`, err.response?.data || err.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Sync Error:", err.response?.data || err.message);
  }
}

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get("/", (req, res) => res.send("🤖 Stream Monitor is running!"));
app.get("/ping", (req, res) => res.status(200).json({ status: "ok", time: new Date().toISOString() }));

app.post("/api/twitch/webhook", (req, res) => {
  const signature = req.headers["twitch-eventsub-message-signature"];
  const messageId = req.headers["twitch-eventsub-message-id"];
  const timestamp = req.headers["twitch-eventsub-message-timestamp"];
  const messageType = req.headers["twitch-eventsub-message-type"];

  if (!signature || ! messageId || !timestamp || !req.rawBody) {
    return res.sendStatus(400);
  }

  // ИСПРАВЛЕНО: Передаем Buffer напрямую без конкатенации со строками, чтобы кириллица и эмодзи не ломали HMAC
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET)
    .update(messageId)
    .update(timestamp)
    .update(req.rawBody)
    .digest("hex");

  if (`sha256=${hmac}` !== signature) {
    console.warn("⚠️ Invalid Webhook Signature! Check TWITCH_WEBHOOK_SECRET.");
    return res.sendStatus(403);
  }

  // Верификация вебхука при создании подписки
  if (messageType === "webhook_callback_verification") {
    console.log(`✅ Webhook Verified for ${req.body.subscription?.type}!`);
    return res.status(200).type("text/plain").send(req.body.challenge);
  }

  // Защита от дублей (если Twitch прислал ретрай)
  if (processedMessages.has(messageId)) {
    return res.sendStatus(200);
  }
  processedMessages.add(messageId);
  if (processedMessages.size > 500) {
    const firstItem = processedMessages.values().next().value;
    processedMessages.delete(firstItem);
  }

  const { subscription, event } = req.body;
  const streamer = monitoredStreamers.find(s => s.id === event?.broadcaster_user_id);

  if (streamer && subscription) {
    console.log(`⚡ [WEBHOOK] Event ${subscription.type} received for ${streamer.login}`);
    if (subscription.type === "stream.online") {
      if (streamer.status === "offline") {
        streamer.status = "online";
        notifyLive(streamer);
      }
    } else if (subscription.type === "stream.offline") {
      streamer.status = "offline";
    } else if (subscription.type === "channel.update") {
      // Обновляем кеш заголовка, чтобы поллинг не дублировал уведомление
      streamer.lastTitle = event.title;
      streamer.lastCategory = event.category_name;
      notifyUpdate(event);
    }
  }
  res.sendStatus(200);
});

function notifyLive(streamer) {
  const login = streamer.login;
  console.log(`📢 ${login} is LIVE!`);

  const qualitySetting = streamer.quality ?? "best";
  const resolvedQuality = qualitySetting === "audio_only"
    ? "audio_only"
    : `${qualitySetting},audio_only`;

  if (bot && TELEGRAM_CHAT_ID) {
    const recordMsg = streamer.record
      ? `\n\nTriggering PC... (Quality: ${resolvedQuality})`
      : '';
    bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `🔴 ${login} is LIVE!\n\nhttps://twitch.tv/${login}${recordMsg}`)
      .catch(err => console.error("Telegram Error:", err.message));
  }
  
  if (streamer.record) {
    io.emit("start_record", { login, quality: resolvedQuality });
  }
}

function notifyUpdate(event) {
  const login = event.broadcaster_user_login;
  const title = event.title;
  const category = event.category_name;
  
  console.log(`📝 [UPDATE] ${login} updated stream info: ${title} (${category})`);
  
  if (bot && TELEGRAM_CHAT_ID) {
    const message = `📝 ${login} updated stream info:\n\n` +
                    `📌 Title: ${title}\n` +
                    `🎮 Category: ${category}`;
    
    bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message)
      .catch(err => console.error("Telegram Error:", err.message));
  }
}

async function pollTwitch() {
  if (monitoredStreamers.length === 0) return;
  if (!appAccessToken) await getAppAccessToken();
  try {
    const logins = monitoredStreamers.map(s => s.login).join("&user_login=");
    const res = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${logins}`, {
      headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` },
    });
    
    const liveStreamsMap = new Map(res.data.data.map(s => [s.user_id, s]));
    
    monitoredStreamers.forEach(s => {
      const streamData = liveStreamsMap.get(s.id);
      const isNowOnline = Boolean(streamData);

      if (isNowOnline && s.status === "offline") {
        s.status = "online";
        s.lastTitle = streamData.title;
        s.lastCategory = streamData.game_name;
        notifyLive(s);
      } else if (!isNowOnline && s.status === "online") {
        s.status = "offline";
      } else if (isNowOnline && s.status === "online") {
        // Запасная проверка смены названия во время стрима, если вебхук вдруг не дошел
        const currentTitle = streamData.title;
        const currentCategory = streamData.game_name;
        if (
          (s.lastTitle !== null && s.lastTitle !== currentTitle) ||
          (s.lastCategory !== null && s.lastCategory !== currentCategory)
        ) {
          s.lastTitle = currentTitle;
          s.lastCategory = currentCategory;
          notifyUpdate({
            broadcaster_user_login: s.login,
            title: currentTitle,
            category_name: currentCategory
          });
        } else if (s.lastTitle === null) {
          s.lastTitle = currentTitle;
          s.lastCategory = currentCategory;
        }
      }
    });
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("🔄 Обновляем истекший токен Twitch...");
      await getAppAccessToken();
    } else {
      console.error("Polling Error:", err.message);
    }
  }
}

app.get("/api/streamers", (req, res) => res.json(monitoredStreamers));

// --- Запуск сервера ---
loadStreamers().then(() => {
  getAppAccessToken().then(async () => {
    httpServer.listen(PORT, "0.0.0.0", async () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 External URL: ${APP_URL || "NOT SET"}`);
      
      startBot();
      setInterval(pollTwitch, 30000);
      
      if (APP_URL) {
        console.log("📡 Syncing Webhooks...");
        await syncEventSub();

        setInterval(() => {
          axios.get(`${APP_URL}/ping`).catch(() => {});
        }, 10 * 60 * 1000);
      }
    });
  });
});
