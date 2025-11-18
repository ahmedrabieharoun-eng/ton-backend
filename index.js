require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const fetch = require("node-fetch");

// ====== إعداد السيرفر ======
const app = express();

// === سجل Origins الواضحة اللي هتسمح بها (عدلها لو احتجت) ===
const allowedOrigins = [
  "https://ahmedrabieharoun-eng.github.io",
  "https://ahmedrabieharoun-eng.github.io/my-website",
  "https://ton-backend-production-83d3.up.railway.app"
];

// Helper: normalize origin (يزيل slash في الآخر)
function normalizeOrigin(o) {
  if (!o) return o;
  return o.replace(/\/$/, "");
}

// لو عايز تفتح السماح مؤقتًا للاختبار، ضيف متغير بيئي: ALLOW_ALL_ORIGINS_FOR_TEST=true
const allowAllForTest = process.env.ALLOW_ALL_ORIGINS_FOR_TEST === "true";

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} Origin:`, req.headers.origin);
  next();
});

// ====== إعداد CORS ======
if (allowAllForTest) {
  // وضع الاختبار: يسمح لأي origin ويرد الهيدرز اللازمة — مخصص للاختبار فقط
  app.use(cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
  }));
  app.options("*", cors());
  console.log("⚠️ CORS: ALLOW ALL ORIGINS FOR TESTING (env ALLOW_ALL_ORIGINS_FOR_TEST=true)");
} else {
  // وضع الإنتاج: قبول origins محددة أو أي .github.io
  app.use(cors({
    origin: function(origin, callback) {
      if (!origin) return callback(null, true); // requests like curl or server-to-server
      const n = normalizeOrigin(origin);
      if (allowedOrigins.includes(n) || n.endsWith(".github.io")) {
        return callback(null, true);
      }
      // رفض origin غير معروف
      return callback(new Error("CORS policy: This origin is not allowed - " + origin), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
  }));
  app.options("*", cors());
  console.log("CORS configured for allowed origins.");
}

// Body parser
app.use(express.json());

// ====== اتصال PostgreSQL (Railway) ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ====== إنشاء الجداول لو مش موجودة ======
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      photo_url TEXT,
      balance NUMERIC(20,8) DEFAULT 0,
      referrals INTEGER DEFAULT 0,
      total_earned NUMERIC(20,8) DEFAULT 0,
      lifetime_ad_count INTEGER DEFAULT 0,
      last_ad_watch_date DATE,
      daily_ad_count INTEGER DEFAULT 0,
      break_until BIGINT DEFAULT 0,
      subscribed_to_channels BOOLEAN DEFAULT FALSE,
      join_date TIMESTAMP DEFAULT NOW(),
      referred_by BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id TEXT PRIMARY KEY,
      user_id BIGINT REFERENCES users(id),
      method TEXT,
      account TEXT,
      amount NUMERIC(20,8),
      status TEXT,
      timestamp BIGINT
    );
  `);

  console.log("✅ Database tables are ready");
}

initDb().catch((err) => {
  console.error("DB init error:", err);
});

// ========= إعدادات عامة ثابتة (تقدر تعدّلها) =========
const CONFIG = {
  currencySymbol: "TON",
  adValue: 0.0001,
  dailyAdLimit: 100,
  minWithdraw: 0.1,
};

// ====== Routes ======
app.get("/", (req, res) => res.send("TON Rewards API is running ✅"));
app.get("/api/config", (req, res) => res.json(CONFIG));

app.post("/api/user/init", async (req, res) => {
  try {
    const { tgUser, referralParam, isSubscribedToAllChannels } = req.body;
    if (!tgUser || !tgUser.id) return res.status(400).json({ error: "tgUser.id is required" });

    const userId = tgUser.id;
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    let user = result.rows[0];

    let referralId = null;
    if (referralParam && !isNaN(Number(referralParam)) && Number(referralParam) !== userId) {
      referralId = Number(referralParam);
    }

    if (!user) {
      const today = new Date().toISOString().slice(0, 10);
      const insertResult = await pool.query(
        `INSERT INTO users (
          id, first_name, last_name, username, photo_url,
          balance, referrals, total_earned,
          lifetime_ad_count, last_ad_watch_date, daily_ad_count,
          break_until, subscribed_to_channels, join_date, referred_by
        )
        VALUES (
          $1,$2,$3,$4,$5,
          0,0,0,
          0,$6,0,
          0,$7,NOW(),$8
        )
        RETURNING *`,
        [
          userId,
          tgUser.first_name || "",
          tgUser.last_name || "",
          tgUser.username || "",
          tgUser.photo_url || "",
          today,
          !!isSubscribedToAllChannels,
          referralId,
        ]
      );
      user = insertResult.rows[0];
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const lastDate = user.last_ad_watch_date ? user.last_ad_watch_date.toISOString().slice(0, 10) : null;
    if (lastDate !== todayStr) {
      const upd = await pool.query("UPDATE users SET daily_ad_count = 0, last_ad_watch_date = $1 WHERE id = $2 RETURNING *", [todayStr, userId]);
      user = upd.rows[0];
    }

    res.json(user);
  } catch (err) {
    console.error("user/init error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/ad/watch", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const adValue = CONFIG.adValue;
    const dailyLimit = CONFIG.dailyAdLimit;

    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    let user = rows[0];
    if (!user) return res.status(400).json({ error: "User not found" });

    const now = Date.now();
    if (user.break_until && Number(user.break_until) > now) return res.status(400).json({ error: "User is in break period" });

    const todayStr = new Date().toISOString().slice(0, 10);
    const lastDate = user.last_ad_watch_date ? user.last_ad_watch_date.toISOString().slice(0, 10) : null;
    let dailyAdCount = user.daily_ad_count || 0;
    if (lastDate !== todayStr) dailyAdCount = 0;
    if (dailyAdCount >= dailyLimit) return res.status(400).json({ error: "Daily ad limit reached" });

    dailyAdCount += 1;
    const breakUntil = 0;

    const updated = await pool.query(
      `UPDATE users
       SET total_earned = total_earned + $1,
           balance = balance + $1,
           lifetime_ad_count = lifetime_ad_count + 1,
           daily_ad_count = $2,
           last_ad_watch_date = $3,
           break_until = $4
       WHERE id = $5
       RETURNING *`,
      [adValue, dailyAdCount, todayStr, breakUntil, userId]
    );

    res.json({ user: updated.rows[0], earned: adValue });
  } catch (err) {
    console.error("ad/watch error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/withdraw", async (req, res) => {
  try {
    const { userId, method, account, amount } = req.body;
    if (!userId || !method || !account || !amount) return res.status(400).json({ error: "Missing fields" });

    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (numericAmount < CONFIG.minWithdraw) return res.status(400).json({ error: `Minimum withdraw is ${CONFIG.minWithdraw}` });

    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    const user = rows[0];
    if (!user) return res.status(400).json({ error: "User not found" });
    if (Number(user.balance) < numericAmount) return res.status(400).json({ error: "Not enough balance" });

    const id = "wd_" + Date.now();
    await pool.query("BEGIN");
    await pool.query("UPDATE users SET balance = balance - $1 WHERE id = $2", [numericAmount, userId]);
    await pool.query(`INSERT INTO withdrawals (id, user_id, method, account, amount, status, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, userId, method, account, numericAmount, "pending", Date.now()]);
    await pool.query("COMMIT");

    res.json({ ok: true, id });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("withdraw error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/subscription/check", async (req, res) => {
  try {
    const { userId, channelUsername } = req.body;
    const botToken = process.env.BOT_TOKEN;
    if (!userId || !channelUsername) return res.status(400).json({ error: "Missing userId or channelUsername" });
    if (!botToken) return res.status(500).json({ error: "BOT_TOKEN not configured" });

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: "@" + channelUsername, user_id: userId })
    });

    const data = await tgRes.json();
    if (!data.ok || !data.result) return res.json({ subscribed: false, status: "left" });

    const status = data.result.status;
    const subscribed = ["member", "administrator", "creator"].includes(status);
    res.json({ subscribed, status });
  } catch (err) {
    console.error("subscription/check error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ====== تشغيل السيرفر ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server is running on port " + PORT);
});
