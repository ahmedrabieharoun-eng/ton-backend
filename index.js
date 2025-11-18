const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// ⚡ إعدادات قاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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

// 🏠 صفحة الترحيب الرئيسية
app.get('/', (req, res) => {
  res.json({ 
    message: 'Welcome to TON Rewards Server',
    status: 'running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ⚙️ مسار التكوين
app.get('/api/config', (req, res) => {
  res.json({ 
    ok: true, 
    time: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    server: 'Railway',
    currencySymbol: 'TON'
  });
});

// 👤 مسار إنشاء/تحميل المستخدم
app.post('/api/user/init', async (req, res) => {
  try {
    const { tgUser, referralParam, isSubscribedToAllChannels } = req.body;
    
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

    // التحقق إذا كان المستخدم موجود بالفعل
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    let user;
    
    if (userCheck.rows.length === 0) {
      // إنشاء مستخدم جديد
      const result = await pool.query(
        `INSERT INTO users (user_id, username, first_name, last_name, balance, total_earned, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING *`,
        [userId, username, firstName, lastName, 0, 0, new Date()]
      );
      user = result.rows[0];
      console.log('✅ New user created:', userId);
    } else {
      // المستخدم موجود
      user = userCheck.rows[0];
      console.log('✅ Existing user loaded:', userId);
    }

    res.json({ 
      ok: true, 
      message: 'User initialized successfully',
      user: {
        id: user.user_id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        balance: parseFloat(user.balance),
        total_earned: parseFloat(user.total_earned),
        created_at: user.created_at
      }
    });
    
  } catch (err) {
    console.error('❌ Error in /api/user/init:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// 📺 مسار مشاهدة الإعلان
app.post('/api/ad/watch', async (req, res) => {
  try {
    const { adId, userId, tgUser, platform = 'telegram' } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'User ID is required' 
      });
    }

    const finalAdId = adId || `ad_${Date.now()}`;
    const rewardAmount = 10; // مكافأة ثابتة لكل إعلان

    // بدء transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. تحديث رصيد المستخدم
      const updateUser = await client.query(
        `UPDATE users 
         SET balance = balance + $1, total_earned = total_earned + $1, updated_at = $2
         WHERE user_id = $3 
         RETURNING *`,
        [rewardAmount, new Date(), userId.toString()]
      );

      if (updateUser.rows.length === 0) {
        throw new Error('User not found');
      }

      const updatedUser = updateUser.rows[0];

      // 2. تسجيل مشاهدة الإعلان
      await client.query(
        `INSERT INTO ad_watches (user_id, ad_id, platform, reward_amount, watched_at) 
         VALUES ($1, $2, $3, $4, $5)`,
        [userId.toString(), finalAdId, platform, rewardAmount, new Date()]
      );

      await client.query('COMMIT');

      console.log(`🎥 User ${userId} watched ad ${finalAdId} and earned ${rewardAmount}`);

      res.json({ 
        ok: true, 
        message: 'Ad watched successfully',
        adId: finalAdId,
        userId: userId,
        reward: rewardAmount,
        user: {
          id: updatedUser.user_id,
          balance: parseFloat(updatedUser.balance),
          total_earned: parseFloat(updatedUser.total_earned)
        },
        timestamp: new Date().toISOString()
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
  } catch (err) {
    console.error('❌ Error in /api/ad/watch:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to record ad watch',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// 💸 مسار السحب
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, method, account, amount, tgUser } = req.body;
    
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

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // التحقق من الرصيد
      const userCheck = await client.query(
        'SELECT balance FROM users WHERE user_id = $1',
        [userId.toString()]
      );

      if (userCheck.rows.length === 0) {
        throw new Error('User not found');
      }

      const currentBalance = parseFloat(userCheck.rows[0].balance);
      
      if (currentBalance < numericAmount) {
        throw new Error('Insufficient balance');
      }

      // خصم المبلغ
      const updateUser = await client.query(
        `UPDATE users 
         SET balance = balance - $1, updated_at = $2
         WHERE user_id = $3 
         RETURNING *`,
        [numericAmount, new Date(), userId.toString()]
      );

      // تسجيل طلب السحب
      await client.query(
        `INSERT INTO withdrawals (user_id, method, account, amount, status, requested_at) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId.toString(), method, account, numericAmount, 'pending', new Date()]
      );

      await client.query('COMMIT');

      console.log(`💸 Withdraw request: User ${userId} - ${numericAmount} ${method} to ${account}`);

      res.json({ 
        ok: true, 
        message: 'Withdraw request submitted successfully',
        amount: numericAmount,
        method: method,
        new_balance: parseFloat(updateUser.rows[0].balance)
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
  } catch (err) {
    console.error('❌ Error in /api/withdraw:', err);
    res.status(500).json({ 
      ok: false, 
      error: err.message || 'Failed to process withdraw request'
    });
  }
});

// 📊 مسار الصحة
app.get('/api/health', async (req, res) => {
  try {
    // التحقق من اتصال قاعدة البيانات
    await pool.query('SELECT 1');
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
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
    error: 'Something went wrong!',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 🚀 تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port', PORT);
  console.log('📡 Environment:', process.env.NODE_ENV || 'development');
  console.log('🗄️ Database connected');
});
