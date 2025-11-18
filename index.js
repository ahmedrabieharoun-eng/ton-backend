// index.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());

// قائمة الأصول المسموح بها
const allowedOrigins = [
  'https://ahmedrabieharoun-eng.github.io',
  'https://t.me',
  'https://telegram.org',
  'https://web.telegram.org'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // السماح بالخدمات بدون origin
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // التعامل مع preflight

// مسار تجريبي للـ /api/ad/watch
app.post('/api/ad/watch', (req, res) => {
  try {
    const { adId, userId } = req.body;
    // هنا يمكن إضافة منطق لمعالجة الإعلان (مثلاً تسجيل عرض إعلان)
    console.log(`User ${userId} watched ad ${adId}`);

    // يمكن إرجاع JSON بناءً على ما يتم من عمل
    return res.json({ ok: true, message: 'Ad watched successfully' });
  } catch (err) {
    console.error('Error in /api/ad/watch', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// بقية المسارات الأخرى مثل /api/config أو /api/user/init...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
