const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ⚡ إعدادات مهمة لـ Railway
app.set('trust proxy', 1); // مهم للتعامل مع الـ proxy في Railway

// 📋 قائمة الأصول المسموح بها (CORS)
const allowedOrigins = [
  'https://ahmedrabieharoun-eng.github.io',
  'https://t.me',
  'https://telegram.org',
 
'https://web.telegram.org',
  'http://localhost:3000', // للتطوير المحلي
  'http://localhost:5173' // للتطوير بمشاريع Vite/React
];

// 🌐 إعدادات CORS محسنة
const corsOptions = {
  origin: (origin, callback) => {
    // السماح بالطلبات بدون origin (مثل Postman أو WebView)
    if (!origin) return callback(null, true);
    
    // التحقق من الأصول المسموح بها
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
    message: 'Welcome to Telegram Bot Server',
    status: 'running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ⚙️ مسار لعرض التكوين والإعدادات
app.get('/api/config', (req, res) => {
  res.json({ 
    ok: true, 
    time: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    server: 'Railway'
  });
});

// 👤 مسار لاستقبال بيانات المستخدم
app.post('/api/user/init', (req, res) => {
  try {
    const { tgUser, initData } = req.body;
    
    // تسجيل بيانات المستخدم
    console.log('📱 User data received:', { 
      userId: tgUser?.id,
      username: tgUser?.username,
      timestamp: new Date().toISOString()
    });

    res.json({ 
      ok: true, 
      message: 'User initialized successfully',
      user: {
        id: tgUser?.id,
        username: tgUser?.username,
        first_name: tgUser?.first_name
      },
      serverTime: new Date().toISOString()
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

// 📺 مسار لتسجيل مشاهدة الإعلان
app.post('/api/ad/watch', (req, res) => {
  try {
    const { adId, userId, platform = 'telegram' } = req.body;
    
    if (!adId || !userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required fields: adId and userId' 
      });
    }

    console.log(`🎥 User ${userId} watched ad ${adId} on ${platform}`);
    
    // هنا يمكنك إضافة منطق لحساب النقاط أو المكافآت
    
    res.json({ 
      ok: true, 
      message: 'Ad watched successfully',
      adId,
      userId,
      reward: 10, // مثال لمكافأة
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

// 📊 مسار للتحقق من صحة الخادم
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development'
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
    error: 'Something went wrong!',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 🚀 تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port', PORT);
  console.log('📡 Environment:', process.env.NODE_ENV || 'development');
  console.log('🌐 CORS Enabled for:', allowedOrigins);
});
