// index.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());

// قائمة الأصول المسموح بها
const allowedOrigins = [
  'https://ahmedrabieharoun-eng.github.io', // صفحتك (GitHub Pages)
  'https://t.me',                          // تلغرام (mobile/web)
  'https://telegram.org',                  // احتمالي
  'https://web.telegram.org'               // web.telegram.org (أحيانًا)
];

// دالة اختيار الـ origin آمن
const corsOptions = {
  origin: (origin, callback) => {
    // إذا origin غير موجود (مثلاً بعض حالات WebView أو server-to-server), نسمح بها
    if (!origin) return callback(null, true);

    // تحقق من وجود الـ origin في القائمة
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // رفض أي origin غير مدرج
    return callback(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
};

// استخدم CORS بالخيارات دي
app.use(cors(corsOptions));

// تأكد إننا نرد على OPTIONS بشكل عام (cors() غالبًا يتعامل معاه، لكن هذا تأكيد)
app.options('*', cors(corsOptions));

// Routes تجريبية
app.get('/', (req, res) => res.send('ok from backend'));
app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    api: true,
    at: new Date()
  });
});

// تأكد إن نستخدم PORT من Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
