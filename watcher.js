import axios from "axios";
import fs from "fs";

// ====== إعدادات ======
const TON_WALLET = "UQBAYBRdcdCxgCF1PFmK1FXBh5dDmohaq6-0YFF37qs8Ffxj";
const TONAPI_KEY = "PUT_TONAPI_KEY_HERE";

const TELEGRAM_BOT_TOKEN = "PUT_BOT_TOKEN_HERE";
const ADMIN_CHAT_ID = "PUT_ADMIN_ID_HERE";

const DB_FILE = "./db.json";

// ====== DB بسيط ======
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, processedTx: [] }, null, 2));
}

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ====== Telegram ======
async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
}

// ====== Watcher ======
async function watchDeposits() {
  try {
    const res = await axios.get(
      `https://tonapi.io/v2/blockchain/accounts/${TON_WALLET}/transactions?limit=20`,
      {
        headers: {
          Authorization: `Bearer ${TONAPI_KEY}`
        }
      }
    );

    const txs = res.data.transactions;
    const db = loadDB();

    for (const tx of txs) {
      if (!tx.in_msg) continue;
      if (!tx.in_msg.decoded_body?.text) continue;

      const comment = tx.in_msg.decoded_body.text.trim();
      if (!comment.startsWith("deposit_")) continue;

      const txHash = tx.hash;
      if (db.processedTx.includes(txHash)) continue;

      const userId = comment.replace("deposit_", "");
      const amountTON = tx.in_msg.value / 1e9;

      // إنشاء المستخدم لو مش موجود
      if (!db.users[userId]) {
        db.users[userId] = { balance: 0 };
      }

      db.users[userId].balance += amountTON;
      db.processedTx.push(txHash);
      saveDB(db);

      const txLink = `https://tonviewer.com/${txHash}`;

      // رسالة للمستخدم
      await sendTelegram(
        userId,
        `✅ <b>Deposit Successful</b>\n\n💰 Amount: <b>${amountTON} TON</b>\n🔗 <a href="${txLink}">View Transaction</a>`
      );

      // رسالة للأدمن
      await sendTelegram(
        ADMIN_CHAT_ID,
        `➕ New Deposit\nUser: ${userId}\nAmount: ${amountTON} TON`
      );

      console.log("Deposit processed:", txHash);
    }
  } catch (err) {
    console.error("Watcher error:", err.message);
  }
}

// ====== تشغيل كل 30 ثانية ======
console.log("🚀 Deposit watcher started...");
setInterval(watchDeposits, 30_000);
