const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json()); // مهم لقراءة الـ JSON في الـ body

// قائمة الأصول المسموح بها (CORS)
const allowedOrigins = [
  'https://ahmedrabieharoun-eng.github.io',  // صفحة الـ GitHub الخاصة بك
  'https://t.me',  // تلغرام
  'https://telegram.org', // تلغرام
  'https://web.telegram.org' // تلغرام من الويب
];

// إعدادات CORS
const corsOptions = {
  origin: (origin, callback) => {
    // السماح بالخدمات بدون origin (مثلما في WebView)
    if (!origin) return callback(null, true); 
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],  // السماح بـ GET و POST و OPTIONS
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'], // رؤوس مسموح بها
  credentials: false  // غير مفعل إذا كنت لا تستخدم كوكيز
};

app.use(cors(corsOptions));  // تطبيق CORS
app.options('*', cors(corsOptions));  // التعامل مع preflight requests

// مسار تجريبي لعرض التكوين
app.get('/api/config', (req, res) => {
  res.json({ ok: true, time: new Date() });
});

// مسار لاستقبال بيانات المستخدم
app.post('/api/user/init', (req, res) => {
  try {
    const { tgUser } = req.body;
    console.log('User data:', tgUser);  // يمكن تخزين بيانات المستخدم في قاعدة بيانات
    res.json({ ok: true, message: 'User initialized', user: tgUser });
  } catch (err) {
    console.error('Error in /api/user/init', err);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

// مسار لتسجيل مشاهدة الإعلان
app.post('/api/ad/watch', (req, res) => {
  try {
    const { adId, userId } = req.body;
    console.log(`User ${userId} watched ad ${adId}`);
    res.json({ ok: true, message: 'Ad watched successfully' });
  } catch (err) {
    console.error('Error in /api/ad/watch', err);
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

// مسار آخر أو إضافات أخرى إذا لزم الأمر

// تعيين البورت ليعمل على البيئة المحلية أو البيئة في Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
