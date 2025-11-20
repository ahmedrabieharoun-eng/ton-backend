// server.js
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

// تكوين قاعدة البيانات PostgreSQL
const pool = new Pool({
  user: 'your_username',
  host: 'localhost',
  database: 'taskerton_db',
  password: 'your_password',
  port: 5432,
});

// إنشاء الجداول إذا لم تكن موجودة
async function createTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE,
        email VARCHAR(255),
        balance DECIMAL(15,8) DEFAULT 0,
        total_earned DECIMAL(15,8) DEFAULT 0,
        ads_watched INTEGER DEFAULT 0,
        referrals INTEGER DEFAULT 0,
        referral_code VARCHAR(50) UNIQUE,
        referred_by INTEGER REFERENCES users(id),
        last_ad_time TIMESTAMP,
        join_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        type VARCHAR(50),
        amount DECIMAL(15,8),
        description TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ad_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        reward DECIMAL(15,8),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wheel_spins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        prize VARCHAR(255),
        amount DECIMAL(15,8),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
  }
}

// المسارات (Routes)

// إنشاء مستخدم جديد
app.post('/api/users', async (req, res) => {
  try {
    const { telegram_id, referral_code } = req.body;
    
    // إنشاء كود دعوة فريد
    const referralCode = generateReferralCode();
    
    const result = await pool.query(
      `INSERT INTO users (telegram_id, referral_code, join_date) 
       VALUES ($1, $2, CURRENT_TIMESTAMP) 
       RETURNING *`,
      [telegram_id, referralCode]
    );

    // إذا كان هناك كود دعوة، تحديث إحالات المستخدم الداعي
    if (referral_code) {
      const referrer = await pool.query(
        'SELECT id FROM users WHERE referral_code = $1',
        [referral_code]
      );
      
      if (referrer.rows.length > 0) {
        await pool.query(
          'UPDATE users SET referrals = referrals + 1 WHERE id = $1',
          [referrer.rows[0].id]
        );
        
        await pool.query(
          'UPDATE users SET referred_by = $1 WHERE id = $2',
          [referrer.rows[0].id, result.rows[0].id]
        );
      }
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// جلب بيانات مستخدم
app.get('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      `SELECT id, email, balance, total_earned, ads_watched, referrals, 
              last_ad_time, join_date 
       FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// مشاهدة إعلان
app.post('/api/users/:id/watch-ad', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const adReward = 0.0001; // مكافأة الإعلان
    
    // التحقق من آخر إعلان
    const userResult = await client.query(
      'SELECT last_ad_time, ads_watched FROM users WHERE id = $1',
      [id]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    const now = new Date();
    
    // التحقق من الوقت بين الإعلانات (30 ثانية)
    if (user.last_ad_time) {
      const lastAdTime = new Date(user.last_ad_time);
      const timeDiff = now - lastAdTime;
      
      if (timeDiff < 30000) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Please wait before watching another ad' });
      }
    }
    
    // التحقق من الحد اليومي (10 إعلانات)
    if (user.ads_watched >= 10) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Daily ad limit reached' });
    }
    
    // تحديث رصيد المستخدم
    await client.query(
      `UPDATE users 
       SET balance = balance + $1, 
           total_earned = total_earned + $1,
           ads_watched = ads_watched + 1,
           last_ad_time = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [adReward, id]
    );
    
    // تسجيل المعاملة
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description)
       VALUES ($1, 'ad_reward', $2, 'Ad watching reward')`,
      [id, adReward]
    );
    
    // تسجيل جلسة الإعلان
    await client.query(
      `INSERT INTO ad_sessions (user_id, reward)
       VALUES ($1, $2)`,
      [id, adReward]
    );
    
    // إذا كان للمستخدم مُحيل، إعطاء العمولة
    const referrerResult = await client.query(
      'SELECT referred_by FROM users WHERE id = $1',
      [id]
    );
    
    if (referrerResult.rows[0]?.referred_by) {
      const referralBonus = adReward * 0.2; // 20% عمولة
      
      await client.query(
        `UPDATE users 
         SET balance = balance + $1,
             total_earned = total_earned + $1
         WHERE id = $2`,
        [referralBonus, referrerResult.rows[0].referred_by]
      );
      
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, description)
         VALUES ($1, 'referral_bonus', $2, 'Referral commission')`,
        [referrerResult.rows[0].referred_by, referralBonus]
      );
    }
    
    await client.query('COMMIT');
    
    // جلب بيانات المستخدم المحدثة
    const updatedUser = await client.query(
      'SELECT balance, total_earned, ads_watched, last_ad_time FROM users WHERE id = $1',
      [id]
    );
    
    res.json(updatedUser.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error processing ad:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// تدوير عجلة الحظ
app.post('/api/users/:id/spin-wheel', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    
    // التحقق من آخر تدوير للعجلة (مرة واحدة يومياً)
    const today = new Date().toDateString();
    const lastSpin = await client.query(
      `SELECT created_at FROM wheel_spins 
       WHERE user_id = $1 AND DATE(created_at) = $2`,
      [id, today]
    );
    
    if (lastSpin.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You can only spin once per day' });
    }
    
    // الجوائز الممكنة
    const prizes = [
      { name: '0.0001 TON', amount: 0.0001 },
      { name: '0.00005 TON', amount: 0.00005 },
      { name: '0.0002 TON', amount: 0.0002 },
      { name: 'حاول مرة أخرى', amount: 0 },
      { name: '0.00015 TON', amount: 0.00015 },
      { name: '0.0001 TON', amount: 0.0001 },
      { name: '0.00005 TON', amount: 0.00005 },
      { name: '0.0003 TON', amount: 0.0003 }
    ];
    
    const randomPrize = prizes[Math.floor(Math.random() * prizes.length)];
    
    // تحديث رصيد المستخدم إذا ربح
    if (randomPrize.amount > 0) {
      await client.query(
        `UPDATE users 
         SET balance = balance + $1,
             total_earned = total_earned + $1
         WHERE id = $2`,
        [randomPrize.amount, id]
      );
      
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, description)
         VALUES ($1, 'wheel_prize', $2, 'Wheel of fortune prize')`,
        [id, randomPrize.amount]
      );
    }
    
    // تسجيل تدوير العجلة
    await client.query(
      `INSERT INTO wheel_spins (user_id, prize, amount)
       VALUES ($1, $2, $3)`,
      [id, randomPrize.name, randomPrize.amount]
    );
    
    await client.query('COMMIT');
    
    res.json({
      prize: randomPrize.name,
      amount: randomPrize.amount
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error spinning wheel:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// تحديث البريد الإلكتروني
app.put('/api/users/:id/email', async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    
    await pool.query(
      'UPDATE users SET email = $1 WHERE id = $2',
      [email, id]
    );
    
    res.json({ message: 'Email updated successfully' });
  } catch (error) {
    console.error('Error updating email:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// طلب سحب الرصيد
app.post('/api/users/:id/withdraw', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { amount, email } = req.body;
    
    // التحقق من الرصيد الكافي
    const userResult = await client.query(
      'SELECT balance FROM users WHERE id = $1',
      [id]
    );
    
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (userResult.rows[0].balance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // خصم المبلغ من الرصيد
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2',
      [amount, id]
    );
    
    // تسجيل طلب السحب
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, status)
       VALUES ($1, 'withdrawal', $2, 'Withdrawal to ' || $3, 'pending')`,
      [id, amount, email]
    );
    
    await client.query('COMMIT');
    
    res.json({ message: 'Withdrawal request submitted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error processing withdrawal:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// دالة مساعدة لإنشاء كود دعوة
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// بدء الخادم
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await createTables();
});
