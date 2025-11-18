const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// ⚡ إعدادات قاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

// ⚡ إعدادات مهمة لـ Railway
app.set('trust proxy', 1);

// 📋 قائمة الأصول المسموح بها
const allowedOrigins = [
  'https://ahmedrabieharoun-eng.github.io',
  'https://t.me',
  'https://telegram.org',
  'https://web.telegram.org',
  'http://localhost:3000',
  'http://localhost:5173'
];

// 🌐 إعدادات CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      console.log('Blocked by CORS:', origin);
      return callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-telegram-init-data'],
  credentials: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔧 تهيئة قاعدة البيانات
async function initializeDatabase() {
  try {
    const client = await pool.connect();
    console.log('✅ Database connected successfully');
    
    // إنشاء الجداول إذا لم تكن موجودة
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) UNIQUE NOT NULL,
        username VARCHAR(100),
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        photo_url TEXT,
        balance DECIMAL(15, 6) DEFAULT 0,
        total_earned DECIMAL(15, 6) DEFAULT 0,
        referrals INTEGER DEFAULT 0,
        referred_by VARCHAR(50),
        lifetime_ad_count INTEGER DEFAULT 0,
        daily_ad_count INTEGER DEFAULT 0,
        last_ad_watch_date DATE,
        break_until BIGINT DEFAULT 0,
        completed_tasks JSONB DEFAULT '{}',
        welcomed BOOLEAN DEFAULT false,
        subscribed_to_channels BOOLEAN DEFAULT false,
        join_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS ad_watches (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        ad_id VARCHAR(100) NOT NULL,
        platform VARCHAR(50) DEFAULT 'telegram',
        reward_amount DECIMAL(10, 6) NOT NULL,
        watch_date DATE DEFAULT CURRENT_DATE,
        watched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        method VARCHAR(50) NOT NULL,
        account VARCHAR(255) NOT NULL,
        amount DECIMAL(15, 6) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_earnings (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        earning_date DATE NOT NULL,
        amount DECIMAL(10, 6) DEFAULT 0,
        UNIQUE(user_id, earning_date)
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        id SERIAL PRIMARY KEY,
        config_key VARCHAR(100) UNIQUE NOT NULL,
        config_value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // إدخال الإعدادات الافتراضية
    await client.query(`
      INSERT INTO app_config (config_key, config_value) 
      VALUES ('ad_config', $1)
      ON CONFLICT (config_key) DO NOTHING
    `, [JSON.stringify({
      adZoneId: "10058786",
      adValue: 0.0001,
      dailyAdLimit: 50,
      adsPerBreak: 10,
      breakDuration: 5,
      referralBonus: 0.001,
      minimumWithdrawReferrals: 0,
      botUsername: "Aborabie777_bot",
      withdrawMethods: [
        { name: "TON Wallet", min: 0.1 },
        { name: "USDT", min: 1.0 }
      ],
      tasks: {
        channel1: { name: "Join Channel 1", reward: 0.001, url: "https://t.me/earnmoney174688", icon: "https://img.icons8.com/ios-filled/100/group.png" },
        channel2: { name: "Join Channel 2", reward: 0.001, url: "https://t.me/earnmoney139482", icon: "https://img.icons8.com/ios-filled/100/money-bag.png" }
      },
      links: {
        channel1: { name: "Main Channel", url: "https://t.me/earnmoney174688", icon: "https://img.icons8.com/ios-filled/100/group.png" },
        channel2: { name: "Withdraw Channel", url: "https://t.me/earnmoney139482", icon: "https://img.icons8.com/ios-filled/100/money-bag.png" }
      }
    })]);
    
    client.release();
    console.log('✅ Database tables verified/created');
  } catch (err) {
    console.error('❌ Database initialization failed:', err);
  }
}

// 🏠 صفحة الترحيب الرئيسية
app.get('/', (req, res) => {
  res.json({ 
    message: 'Welcome to TON Rewards Server',
    status: 'running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ⚙️ مسار الحصول على الإعدادات
app.get('/api/config', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT config_value FROM app_config WHERE config_key = $1',
      ['ad_config']
    );
    
    const config = result.rows[0]?.config_value || {};
    
    res.json({ 
      ok: true, 
      ...config,
      time: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      server: 'Railway'
    });
    
  } catch (err) {
    console.error('❌ Error in /api/config:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to load config' 
    });
  }
});

// 👤 مسار إنشاء/تحميل المستخدم
app.post('/api/user/init', async (req, res) => {
  try {
    const { tgUser, referralParam, isSubscribedToAllChannels = false } = req.body;
    
    console.log('📥 Received user init request:', { 
      userId: tgUser?.id,
      username: tgUser?.username 
    });

    if (!tgUser || !tgUser.id) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Telegram user data is required' 
      });
    }

    const userId = tgUser.id.toString();
    const username = tgUser.username || `user_${userId}`;
    const firstName = tgUser.first_name || '';
    const lastName = tgUser.last_name || '';
    const photoUrl = tgUser.photo_url || '';

    const today = new Date().toISOString().slice(0, 10);

    // التحقق إذا كان المستخدم موجود أو إنشاء جديد
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    let user;
    
    if (userCheck.rows.length === 0) {
      // إنشاء مستخدم جديد
      const result = await pool.query(
        `INSERT INTO users (
          user_id, username, first_name, last_name, photo_url, 
          balance, total_earned, referrals, referred_by,
          daily_ad_count, last_ad_watch_date, subscribed_to_channels
        ) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
         RETURNING *`,
        [
          userId, username, firstName, lastName, photoUrl,
          0, 0, 0, referralParam || null,
          0, today, isSubscribedToAllChannels
        ]
      );
      user = result.rows[0];
      console.log('✅ New user created in DB:', userId);

      // معالجة الإحالة إذا كانت موجودة
      if (referralParam && referralParam !== userId) {
        await processReferral(referralParam, userId);
      }
    } else {
      // المستخدم موجود - تحديث البيانات إذا لزم الأمر
      user = userCheck.rows[0];
      
      // إعادة تعيين العداد اليومي إذا تغير التاريخ
      if (user.last_ad_watch_date !== today) {
        await pool.query(
          'UPDATE users SET daily_ad_count = 0, last_ad_watch_date = $1 WHERE user_id = $2',
          [today, userId]
        );
        user.daily_ad_count = 0;
      }
      
      console.log('✅ Existing user loaded from DB:', userId);
    }

    res.json({ 
      ok: true, 
      message: 'User initialized successfully',
      user: {
        id: user.user_id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        photo_url: user.photo_url,
        balance: parseFloat(user.balance),
        total_earned: parseFloat(user.total_earned),
        referrals: user.referrals,
        daily_ad_count: user.daily_ad_count,
        lifetime_ad_count: user.lifetime_ad_count,
        break_until: user.break_until,
        completed_tasks: user.completed_tasks || {},
        subscribed_to_channels: user.subscribed_to_channels,
        created_at: user.created_at
      }
    });
    
  } catch (err) {
    console.error('❌ Error in /api/user/init:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Internal server error: ' + err.message
    });
  }
});

// 📺 مسار مشاهدة الإعلان
app.post('/api/ad/watch', async (req, res) => {
  try {
    const { adId, userId, tgUser, platform = 'telegram' } = req.body;
    
    console.log('📥 Received ad watch request:', { userId, adId });

    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'User ID is required' 
      });
    }

    const finalAdId = adId || `ad_${Date.now()}`;
    
    // الحصول على قيمة الإعلان من الإعدادات
    const configResult = await pool.query(
      'SELECT config_value FROM app_config WHERE config_key = $1',
      ['ad_config']
    );
    const config = configResult.rows[0]?.config_value || {};
    const rewardAmount = config.adValue || 0.0001;
    const dailyAdLimit = config.dailyAdLimit || 50;

    // التحقق من الحد اليومي
    const userCheck = await pool.query(
      'SELECT daily_ad_count FROM users WHERE user_id = $1',
      [userId.toString()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ 
        ok: false, 
        error: 'User not found. Please initialize user first.' 
      });
    }

    const user = userCheck.rows[0];
    
    if (user.daily_ad_count >= dailyAdLimit) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Daily ad limit reached' 
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    // تحديث رصيد المستخدم
    const result = await pool.query(
      `UPDATE users 
       SET 
         balance = balance + $1, 
         total_earned = total_earned + $1,
         daily_ad_count = daily_ad_count + 1,
         lifetime_ad_count = lifetime_ad_count + 1,
         last_ad_watch_date = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $3 
       RETURNING *`,
      [rewardAmount, today, userId.toString()]
    );

    const updatedUser = result.rows[0];

    // تسجيل مشاهدة الإعلان
    await pool.query(
      `INSERT INTO ad_watches (user_id, ad_id, platform, reward_amount, watch_date) 
       VALUES ($1, $2, $3, $4, $5)`,
      [userId.toString(), finalAdId, platform, rewardAmount, today]
    );

    // تحديث إحصائيات الأرباح اليومية
    await pool.query(
      `INSERT INTO user_earnings (user_id, earning_date, amount) 
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, earning_date) 
       DO UPDATE SET amount = user_earnings.amount + $3`,
      [userId.toString(), today, rewardAmount]
    );

    console.log(`🎥 User ${userId} watched ad ${finalAdId} and earned ${rewardAmount}. New balance: ${updatedUser.balance}`);

    res.json({ 
      ok: true, 
      message: 'Ad watched successfully',
      adId: finalAdId,
      userId: userId,
      reward: rewardAmount,
      user: {
        id: updatedUser.user_id,
        balance: parseFloat(updatedUser.balance),
        total_earned: parseFloat(updatedUser.total_earned),
        daily_ad_count: updatedUser.daily_ad_count,
        lifetime_ad_count: updatedUser.lifetime_ad_count
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('❌ Error in /api/ad/watch:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to record ad watch: ' + err.message
    });
  }
});

// 💸 مسار السحب
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, method, account, amount, tgUser } = req.body;
    
    console.log('📥 Received withdraw request:', { userId, method, amount });

    if (!userId || !method || !account || !amount) {
      return res.status(400).json({ 
        ok: false, 
        error: 'All fields are required: userId, method, account, amount' 
      });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invalid amount' 
      });
    }

    // التحقق من الرصيد
    const userCheck = await pool.query(
      'SELECT balance, referrals FROM users WHERE user_id = $1',
      [userId.toString()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ 
        ok: false, 
        error: 'User not found' 
      });
    }

    const user = userCheck.rows[0];
    const currentBalance = parseFloat(user.balance);
    
    if (currentBalance < numericAmount) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Insufficient balance' 
      });
    }

    // التحقق من الحد الأدنى للإحالات إذا كان مطبقاً
    const configResult = await pool.query(
      'SELECT config_value FROM app_config WHERE config_key = $1',
      ['ad_config']
    );
    const config = configResult.rows[0]?.config_value || {};
    const minReferrals = config.minimumWithdrawReferrals || 0;

    if (minReferrals > 0 && user.referrals < minReferrals) {
      return res.status(400).json({ 
        ok: false, 
        error: `Minimum ${minReferrals} referrals required for withdrawal` 
      });
    }

    // خصم المبلغ وتسجيل طلب السحب
    const updateResult = await pool.query(
      `UPDATE users 
       SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 
       RETURNING *`,
      [numericAmount, userId.toString()]
    );

    await pool.query(
      `INSERT INTO withdrawals (user_id, method, account, amount, status) 
       VALUES ($1, $2, $3, $4, $5)`,
      [userId.toString(), method, account, numericAmount, 'pending']
    );

    console.log(`💸 Withdraw processed: User ${userId} - ${numericAmount} ${method} to ${account}. New balance: ${updateResult.rows[0].balance}`);

    res.json({ 
      ok: true, 
      message: 'Withdraw request submitted successfully',
      amount: numericAmount,
      method: method,
      new_balance: parseFloat(updateResult.rows[0].balance)
    });
    
  } catch (err) {
    console.error('❌ Error in /api/withdraw:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to process withdraw request: ' + err.message
    });
  }
});

// 📊 مسار الحصول على إحصائيات الأرباح
app.get('/api/user/earnings/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { days = 7 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    const startDateStr = startDate.toISOString().slice(0, 10);

    const result = await pool.query(
      `SELECT earning_date, amount 
       FROM user_earnings 
       WHERE user_id = $1 AND earning_date >= $2 
       ORDER BY earning_date ASC`,
      [userId, startDateStr]
    );

    const earnings = {};
    result.rows.forEach(row => {
      earnings[row.earning_date] = parseFloat(row.amount);
    });

    res.json({
      ok: true,
      earnings,
      total_days: result.rows.length
    });

  } catch (err) {
    console.error('❌ Error in /api/user/earnings:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to load earnings data' 
    });
  }
});

// 🏆 مسار اللوائح
app.get('/api/leaderboard/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { limit = 10 } = req.query;

    let orderBy;
    if (type === 'referral') {
      orderBy = 'referrals DESC';
    } else if (type === 'earning') {
      orderBy = 'total_earned DESC';
    } else {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invalid leaderboard type' 
      });
    }

    const result = await pool.query(
      `SELECT user_id, username, first_name, last_name, photo_url, 
              referrals, total_earned, balance
       FROM users 
       WHERE user_id IS NOT NULL
       ORDER BY ${orderBy} 
       LIMIT $1`,
      [parseInt(limit)]
    );

    res.json({
      ok: true,
      type,
      leaderboard: result.rows.map(user => ({
        id: user.user_id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        photo_url: user.photo_url,
        referrals: user.referrals,
        total_earned: parseFloat(user.total_earned),
        balance: parseFloat(user.balance)
      }))
    });

  } catch (err) {
    console.error('❌ Error in /api/leaderboard:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to load leaderboard' 
    });
  }
});

// 📋 مسار تحديث المهام
app.post('/api/user/tasks', async (req, res) => {
  try {
    const { userId, taskId } = req.body;

    if (!userId || !taskId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'User ID and task ID are required' 
      });
    }

    // الحصول على معلومات المهمة من الإعدادات
    const configResult = await pool.query(
      'SELECT config_value FROM app_config WHERE config_key = $1',
      ['ad_config']
    );
    const config = configResult.rows[0]?.config_value || {};
    const task = config.tasks?.[taskId];

    if (!task) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Task not found' 
      });
    }

    // التحقق إذا كانت المهمة مكتملة بالفعل
    const userCheck = await pool.query(
      'SELECT completed_tasks FROM users WHERE user_id = $1',
      [userId.toString()]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ 
        ok: false, 
        error: 'User not found' 
      });
    }

    const user = userCheck.rows[0];
    const completedTasks = user.completed_tasks || {};

    if (completedTasks[taskId]) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Task already completed' 
      });
    }

    // تحديث المهام المكتملة والرصيد
    completedTasks[taskId] = true;
    const rewardAmount = task.reward || 0;

    const updateResult = await pool.query(
      `UPDATE users 
       SET 
         balance = balance + $1,
         completed_tasks = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $3 
       RETURNING *`,
      [rewardAmount, completedTasks, userId.toString()]
    );

    res.json({
      ok: true,
      message: 'Task completed successfully',
      reward: rewardAmount,
      user: {
        id: updateResult.rows[0].user_id,
        balance: parseFloat(updateResult.rows[0].balance),
        completed_tasks: updateResult.rows[0].completed_tasks
      }
    });

  } catch (err) {
    console.error('❌ Error in /api/user/tasks:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to update task: ' + err.message
    });
  }
});

// 🔧 دالة مساعدة لمعالجة الإحالات
async function processReferral(referrerId, newUserId) {
  try {
    const configResult = await pool.query(
      'SELECT config_value FROM app_config WHERE config_key = $1',
      ['ad_config']
    );
    const config = configResult.rows[0]?.config_value || {};
    const bonusAmount = config.referralBonus || 0.001;

    if (bonusAmount > 0) {
      // تحديث بيانات المُحيل
      await pool.query(
        `UPDATE users 
         SET 
           balance = balance + $1,
           referrals = referrals + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [bonusAmount, referrerId]
      );
      
      console.log(`🎉 Referral credited: ${referrerId} got ${bonusAmount} TON for referring ${newUserId}`);
    }
  } catch (error) {
    console.error("Error processing referral:", error);
  }
}

// 📊 مسار الصحة
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      total_users: parseInt(usersCount.rows[0].count),
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: err.message
    });
  }
});

// 🚫 التعامل مع المسارات غير الموجودة
app.use('*', (req, res) => {
  res.status(404).json({ 
    ok: false, 
    error: 'Route not found',
    path: req.originalUrl 
  });
});

// ⚠️ معالج الأخطاء العام
app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err);
  res.status(500).json({ 
    ok: false, 
    error: 'Something went wrong!'
  });
});

// 🚀 تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log('🚀 Server running on port', PORT);
  console.log('📡 Environment:', process.env.NODE_ENV || 'development');
  
  // Initialize database connection
  await initializeDatabase();
});
