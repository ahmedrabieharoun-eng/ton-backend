// index.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json()); // مهم لقراءة JSON body

// whitelist للأورجنات المطلوبة
const allowedOrigins = [
  'https://ahmedrabieharoun-eng.github.io',
  'https://t.me',
  'https://telegram.org',
  'https://web.telegram.org'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // بعض WebViews يرسلون no origin
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
  credentials: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // handle preflight

// Health / config route
app.get('/api/config', (req, res) => {
  res.json({ ok: true, time: new Date() });
});

// Implement POST /api/user/init
app.post('/api/user/init', (req, res) => {
  try {
    const body = req.body || {};
    // هنا يمكنك عمل أي لوجيك: تسجيل مستخدم في DB، إنشاء صفوف، إلخ.
    // للآن نعيد تأكيد الاستلام مع نسخة من الجسم
    return res.json({ ok: true, message: 'user init received', body });
  } catch (err) {
    console.error('Error in /api/user/init', err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// أي routes إضافية اكتبها هنا...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
