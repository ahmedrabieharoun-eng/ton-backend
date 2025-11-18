const express = require('express');
const cors = require('cors');

const app = express();

// ⚡ إعدادات مهمة لـ Railway
app.set('trust proxy', 1);

// 📋 قائمة الأصول المسموح بها
const allowedOrigins = [
  'https://ahmedrabieharoun-eng.github.io',
  'https://t.me',
  'https://telegram.org',
  'https://web.telegram.org',
  'http://localhost:3000',
  'http://localhost:5173',
  'https://your-username.github.io' // اضف اسم المستخدم الحقيقي
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

// 📊 تخزين مؤقت للمستخدمين (مؤقت حتى نصلح قاعدة البيانات)
let usersCache = new Map();

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

// 👤 مسار إنشاء/تحميل المستخدم (بدون قاعدة بيانات مؤقتاً)
app.post('/api/user/init', async (req, res) => {
  try {
    const { tgUser, referralParam, isSubscribedToAllChannels } = req.body;
    
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
    const userKey = `user_${userId}`;

    // التحقق إذا كان المستخدم موجود في الكاش
    if (!usersCache.has(userKey)) {
      // إنشاء مستخدم جديد
      const newUser = {
        user_id: userId,
        username: tgUser.username || `user_${userId}`,
        first_name: tgUser.first_name || '',
        last_name: tgUser.last_name || '',
        balance: 0,
        total_earned: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      usersCache.set(userKey, newUser);
      console.log('✅ New user created in cache:', userId);
    } else {
      console.log('✅ Existing user loaded from cache:', userId);
    }

    const user = usersCache.get(userKey);

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
      details: 'User initialization failed'
    });
  }
});

// 📺 مسار مشاهدة الإعلان (بدون قاعدة بيانات مؤقتاً)
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
    const rewardAmount = 10; // مكافأة ثابتة لكل إعلان
    const userKey = `user_${userId.toString()}`;

    // التحقق من وجود المستخدم
    if (!usersCache.has(userKey)) {
      return res.status(404).json({ 
        ok: false, 
        error: 'User not found. Please initialize user first.' 
      });
    }

    // تحديث رصيد المستخدم
    const user = usersCache.get(userKey);
    user.balance += rewardAmount;
    user.total_earned += rewardAmount;
    user.updated_at = new Date().toISOString();
    
    usersCache.set(userKey, user);

    console.log(`🎥 User ${userId} watched ad ${finalAdId} and earned ${rewardAmount}. New balance: ${user.balance}`);

    res.json({ 
      ok: true, 
      message: 'Ad watched successfully',
      adId: finalAdId,
      userId: userId,
      reward: rewardAmount,
      user: {
        id: user.user_id,
        balance: parseFloat(user.balance),
        total_earned: parseFloat(user.total_earned)
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('❌ Error in /api/ad/watch:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to record ad watch'
    });
  }
});

// 💸 مسار السحب (بدون قاعدة بيانات مؤقتاً)
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

    const userKey = `user_${userId.toString()}`;

    // التحقق من وجود المستخدم
    if (!usersCache.has(userKey)) {
      return res.status(404).json({ 
        ok: false, 
        error: 'User not found' 
      });
    }

    const user = usersCache.get(userKey);
    
    // التحقق من الرصيد
    if (user.balance < numericAmount) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Insufficient balance' 
      });
    }

    // خصم المبلغ
    user.balance -= numericAmount;
    user.updated_at = new Date().toISOString();
    usersCache.set(userKey, user);

    console.log(`💸 Withdraw processed: User ${userId} - ${numericAmount} ${method} to ${account}. New balance: ${user.balance}`);

    res.json({ 
      ok: true, 
      message: 'Withdraw request submitted successfully',
      amount: numericAmount,
      method: method,
      new_balance: parseFloat(user.balance)
    });
    
  } catch (err) {
    console.error('❌ Error in /api/withdraw:', err);
    res.status(500).json({ 
      ok: false, 
      error: 'Failed to process withdraw request'
    });
  }
});

// 📊 مسار الصحة
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    users_count: usersCache.size,
    environment: process.env.NODE_ENV || 'development',
    memory: process.memoryUsage()
  });
});

// 🗃️ مسار لعرض جميع المستخدمين (للت debugging)
app.get('/api/debug/users', (req, res) => {
  const users = Array.from(usersCache.values());
  res.json({
    ok: true,
    total_users: users.length,
    users: users
  });
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
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port', PORT);
  console.log('📡 Environment:', process.env.NODE_ENV || 'development');
  console.log('💾 Using in-memory storage (cache)');
  console.log('🌐 CORS Enabled for:', allowedOrigins);
});
