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
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_URL = process.env.APP_URL?.replace(/\/$/, ""); // Убираем слэш на конце, если есть
const WEBHOOK_SECRET = process.env.TWITCH_WEBHOOK_SECRET || "super_secret_key_123";

// Настройки для GitHub Gist
const GIST_ID = process.env.GIST_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_FILENAME = "streamers.json";

// --- State & Storage ---
let monitoredStreamers = [];
let appAccessToken = null;
let isBotActive = true;

// Загрузка стримеров из GitHub Gist
async function loadStreamers() {
  if (!GIST_ID || !GITHUB_TOKEN) {
    console.warn("⚠️ GIST_ID или GITHUB_TOKEN не заданы! Список будет храниться только в памяти.");
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
        quality: s.quality ?? "best"
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

// Сохранение стримеров в GitHub Gist
async function saveStreamers() {
  if (!GIST_ID || !GITHUB_TOKEN) return;
  try {
    // Чтобы не затирать Gist лишний раз при смене только статуса онлайна, сохраняем чистую конфигурацию
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
    ctx.reply(`✅ Added ${login}. Notifications are ON, but PC Recording is OFF by default. Use /record ${login} to enable recording.`);
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

  bot.command("commands", (ctx) => {
    ctx.reply(
      "📖 Available Commands:\n\n" +
      "/add <username> — Add a streamer to monitor\n" +
      "/remove <username> — Remove a streamer\n" +
      "/list — Show all monitored streamers with status\n" +
      "/record <username> — Toggle PC recording on/off\n" +
      "/quality <username> <quality> — Set recording quality\n" +
      "   Options: best | 1080p | 720p | 480p | audio_only\n" +
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
    // dropPendingUpdates помогает избежать спама старыми командами при перезапуске на Render
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

// Корректная остановка бота при перезапуске контейнера Render
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
    if (err.response?.status === 401) {
      await getAppAccessToken();
    }
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

async function syncEventSub() {
  if (!APP_URL || !appAccessToken) return;
  const callbackUrl = `${APP_URL}/api/twitch/webhook`;
  
  try {
    const subsRes = await axios.get("https://api.twitch.tv/helix/eventsub/subscriptions", {
      headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` }
    });
    
    const existingSubs = subsRes.data.data;
    console.log(`📡 Twitch has ${existingSubs.length} active subscriptions.`);

    for (const sub of existingSubs) {
      const isWrongUrl = sub.transport.callback !== callbackUrl;
      const isFailed = sub.status === "notification_failures_exceeded";
      const isOrphaned = !monitoredStreamers.find(s => s.id === sub.condition.broadcaster_user_id);
      
      if (isWrongUrl || isFailed || isOrphaned) {
        let reason = isWrongUrl ? "URL Mismatch" : (isFailed ? "Failed" : "Orphaned");
        console.log(`🗑️ Deleting invalid sub: ${sub.type} (Reason: ${reason})`);
        await axios.delete(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${sub.id}`, {
          headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` }
        }).catch(() => {});
      }
    }

    const types = ["stream.online", "stream.offline", "channel.update"];
    for (const streamer of monitoredStreamers) {
      for (const type of types) {
        const alreadyExists = existingSubs.find(s => 
          s.type === type && 
          s.condition.broadcaster_user_id === streamer.id &&
          s.transport.callback === callbackUrl &&
          s.status !== "notification_failures_exceeded"
        );

        if (!alreadyExists) {
          try {
            await axios.post("https://api.twitch.tv/helix/eventsub/subscriptions", {
              type, version: "1", condition: { broadcaster_user_id: streamer.id },
              transport: { method: "webhook", callback: callbackUrl, secret: WEBHOOK_SECRET }
            }, { headers: { "Client-ID": TWITCH_CLIENT_ID, Authorization: `Bearer ${appAccessToken}` } });
            console.log(`✅ Subscribed: ${type} for ${streamer.login}`);
          } catch (err) {
            if (err.response?.status === 409) {
              console.log(`ℹ️ ${type} for ${streamer.login} already exists.`);
            } else {
              console.error(`❌ Sub Error (${type}):`, err.response?.data || err.message);
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

// --- Эндпоинты для поддержания активности (Anti-Sleep) ---
app.get("/", (req, res) => res.send("🤖 Stream Monitor is running!"));
app.get("/ping", (req, res) => res.status(200).json({ status: "ok", time: new Date().toISOString() }));

app.post("/api/twitch/webhook", (req, res) => {
  const signature = req.headers["twitch-eventsub-message-signature"];
  const messageId = req.headers["twitch-eventsub-message-id"];
  const timestamp = req.headers["twitch-eventsub-message-timestamp"];

  if (!signature || !req.rawBody) return res.sendStatus(400);

  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET)
    .update(messageId + timestamp + req.rawBody)
    .digest("hex");

  if (`sha256=${hmac}` !== signature) {
    console.warn("⚠️ Invalid Webhook Signature");
    return res.sendStatus(403);
  }

  if (req.headers["twitch-eventsub-message-type"] === "webhook_callback_verification") {
    console.log("✅ Webhook Verified!");
    return res.send(req.body.challenge);
  }

  const { subscription, event } = req.body;
  const streamer = monitoredStreamers.find(s => s.id === event.broadcaster_user_id);

  if (streamer) {
    if (subscription.type === "stream.online") {
      if (streamer.status === "offline") {
        streamer.status = "online";
        notifyLive(streamer);
      }
    } else if (subscription.type === "stream.offline") {
      streamer.status = "offline";
    } else if (subscription.type === "channel.update") {
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
  
  console.log(`📝 [UPDATE] ${login} updated stream info.`);
  
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
    const liveIds = new Set(res.data.data.map(s => s.user_id));
    
    monitoredStreamers.forEach(s => {
      const isNowOnline = liveIds.has(s.id);
      if (isNowOnline && s.status === "offline") {
        s.status = "online";
        notifyLive(s);
      } else if (!isNowOnline && s.status === "online") {
        s.status = "offline";
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
      
      startBot();
      setInterval(pollTwitch, 30000);
      
      if (APP_URL) {
        console.log("📡 Syncing Webhooks...");
        await syncEventSub();

        // Дополнительный self-ping каждые 10 минут через внешний роутер Render
        setInterval(() => {
          axios.get(`${APP_URL}/ping`).catch(() => {});
        }, 10 * 60 * 1000);
      }
    });
  });
});