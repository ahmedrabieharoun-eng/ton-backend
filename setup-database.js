const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function setupDatabase() {
    try {
        console.log('🔧 بدء إعداد قاعدة البيانات...');

        // 1. إنشاء جدول المستخدمين
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                first_name VARCHAR(255) NOT NULL DEFAULT 'مستخدم',
                balance DECIMAL(15, 8) DEFAULT 0.00000000,
                earning_wallet DECIMAL(15, 8) DEFAULT 0.00000000,
                total_earned DECIMAL(15, 8) DEFAULT 0.00000000,
                daily_ad_count INTEGER DEFAULT 0,
                last_ad_date DATE DEFAULT CURRENT_DATE,
                referrals INTEGER DEFAULT 0,
                referred_by BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ تم إنشاء جدول bot_users');

        // 2. إنشاء جدول السحوبات
        await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                amount DECIMAL(15, 8) NOT NULL,
                wallet_address TEXT NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                method VARCHAR(100) DEFAULT 'TON Wallet',
                memo TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ تم إنشاء جدول withdrawals');

        // 3. إنشاء جدول المسابقة
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contest_leaderboard (
                id SERIAL PRIMARY KEY,
                user_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                first_name VARCHAR(255),
                points INTEGER DEFAULT 0,
                ads_watched INTEGER DEFAULT 0,
                referrals_count INTEGER DEFAULT 0,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ تم إنشاء جدول contest_leaderboard');

        // 4. إنشاء جدول الإحالات
        await pool.query(`
            CREATE TABLE IF NOT EXISTS referrals (
                id SERIAL PRIMARY KEY,
                referrer_id BIGINT NOT NULL,
                referred_id BIGINT UNIQUE NOT NULL,
                referrer_earnings DECIMAL(15, 8) DEFAULT 0,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ تم إنشاء جدول referrals');

        // 5. إضافة الفهارس للأداء
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_bot_users_telegram_id ON bot_users(telegram_id);
            CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
            CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
            CREATE INDEX IF NOT EXISTS idx_contest_leaderboard_points ON contest_leaderboard(points DESC);
            CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
        `);
        console.log('✅ تم إضافة الفهارس');

        console.log('🎉 تم إعداد قاعدة البيانات بنجاح!');
        
    } catch (error) {
        console.error('❌ خطأ في إعداد قاعدة البيانات:', error);
    } finally {
        await pool.end();
    }
}

setupDatabase();
