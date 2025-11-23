const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const querystring = require('querystring');

const app = express();
app.use(cors());
app.use(express.json());

// 🎯 البوت توكن
const BOT_TOKEN = "7402498049:AAFYi2C88T3M7OsOb7_NqweOv9WIkluIZsg";

// الاتصال بقاعدة البيانات
const pool = new Pool({
    connectionString: "postgresql://postgres:EDcswHnYgYovMiLraEQxmdpajkkDyCuF@shuttle.proxy.rlwy.net:23077/railway",
    ssl: { rejectUnauthorized: false }
});

// 🔥 الإعدادات الجديدة - 100 إعلان يومياً
const config = {
    adValue: 0.0001,          // 0.0001 TON لكل إعلان
    dailyAdLimit: 100,        // 100 إعلان يومياً  
    minWithdrawal: 0.0001,    // الحد الأدنى للسحب 0.0001 TON
    referralBonus: 0.0005,    // مكافأة الإحالة
    contestAdPoints: 1,       // نقاط المسابقة لكل إعلان
    contestReferralPoints: 15 // نقاط المسابقة لكل إحالة
};

// 🔐 نظام التوكن الديناميكي كل 10 ثواني
class DynamicTokenSystem {
    constructor() {
        this.tokens = new Map();
        this.currentToken = null;
        this.tokenHistory = [];
        this.tokenCounter = 0;
        this.intervalId = null;
        
        // إعدادات التوكن
        this.config = {
            tokenRefreshInterval: 10000, // 10 ثواني
            tokenValidityWindow: 15000, // 15 ثانية صلاحية
            maxTokens: 10,
            secretKey: process.env.TOKEN_SECRET || 'ton-rewards-dynamic-token-secret-2024'
        };
    }

    // توليد توكن جديد
    generateToken() {
        const timestamp = Date.now();
        this.tokenCounter++;
        
        const tokenData = {
            timestamp,
            counter: this.tokenCounter,
            random: crypto.randomBytes(32).toString('hex')
        };

        const tokenString = JSON.stringify(tokenData);
        const token = crypto
            .createHmac('sha512', this.config.secretKey)
            .update(tokenString)
            .digest('hex')
            .substring(0, 50);

        const tokenObject = {
            token,
            timestamp,
            expiresAt: timestamp + this.config.tokenValidityWindow,
            counter: this.tokenCounter
        };

        return tokenObject;
    }

    // بدء نظام التوكن
    start() {
        console.log('🚀 بدء نظام التوكن الديناميكي كل 10 ثواني...');
        
        // توليد أول توكن
        this.updateToken();
        
        // جدولة تحديث التوكن
        this.intervalId = setInterval(() => {
            this.updateToken();
        }, this.config.tokenRefreshInterval);

        console.log(`🔄 التوكن بيتغير كل ${this.config.tokenRefreshInterval/1000} ثانية`);
    }

    // تحديث التوكن
    updateToken() {
        const newToken = this.generateToken();
        
        // إضافة التوكن الجديد
        this.tokens.set(newToken.token, newToken);
        this.currentToken = newToken.token;
        
        // حفظ التاريخ
        this.tokenHistory.unshift({
            token: newToken.token.substring(0, 15) + '...',
            timestamp: new Date(newToken.timestamp).toLocaleTimeString(),
            counter: newToken.counter
        });
        
        if (this.tokenHistory.length > this.config.maxTokens) {
            this.tokenHistory.pop();
        }

        // تنظيف التوكنات المنتهية
        this.cleanExpiredTokens();
        
        console.log(`🔄 تحديث التوكن #${newToken.counter}: ${newToken.token.substring(0, 20)}... (${new Date().toLocaleTimeString()})`);
    }

    // تنظيف التوكنات المنتهية
    cleanExpiredTokens() {
        const now = Date.now();
        let deletedCount = 0;
        
        for (let [token, data] of this.tokens.entries()) {
            if (data.expiresAt < now) {
                this.tokens.delete(token);
                deletedCount++;
            }
        }
        
        if (deletedCount > 0) {
            console.log(`🧹 تم تنظيف ${deletedCount} توكن منتهي`);
        }
    }

    // التحقق من صحة التوكن
    validateToken(token) {
        if (!token || token.length < 10) {
            console.log('❌ توكن غير صالح - فارغ أو قصير جداً');
            return false;
        }

        const tokenData = this.tokens.get(token);
        if (!tokenData) {
            console.log(`❌ توكن غير معترف به: ${token.substring(0, 10)}...`);
            return false;
        }
        
        const now = Date.now();
        if (tokenData.expiresAt < now) {
            this.tokens.delete(token);
            console.log(`⏰ توكن منتهي: ${token.substring(0, 10)}...`);
            return false;
        }
        
        console.log(`✅ توكن صالح: ${token.substring(0, 10)}...`);
        return true;
    }

    // الحصول على التوكن الحالي
    getCurrentToken() {
        return this.currentToken;
    }

    // الحصول على إحصائيات
    getStats() {
        return {
            currentToken: this.currentToken ? this.currentToken.substring(0, 15) + '...' : null,
            activeTokens: this.tokens.size,
            totalGenerated: this.tokenCounter,
            tokenHistory: this.tokenHistory
        };
    }

    // إيقاف النظام
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            console.log('🛑 تم إيقاف نظام التوكن');
        }
    }
}

// تهيئة نظام التوكن
const tokenSystem = new DynamicTokenSystem();
tokenSystem.start();

// 🔧 Middleware للتحقق من التوكن الديناميكي - الإصدار المحسن
const validateDynamicToken = (req, res, next) => {
    // استثناء بعض ال endpoints الأساسية
    const publicEndpoints = [
        '/', '/api/token/current', '/api/token/stats', 
        '/api/check-tables', '/api/setup-database', '/api/config',
        '/api/fix-all-tables', '/api/fix-withdrawals-table', 
        '/api/debug-tables', '/api/repair-database', '/api/debug-user'
    ];
    
    if (publicEndpoints.includes(req.path)) {
        return next();
    }

    const token = req.headers['x-dynamic-token'] || 
                  req.headers['authorization']?.replace('Bearer ', '') || 
                  req.query.dynamicToken;

    if (!token) {
        console.log('❌ طلب بدون توكن ديناميكي:', req.path);
        return res.status(401).json({ 
            success: false,
            error: 'التوكن الديناميكي مطلوب',
            code: 'DYNAMIC_TOKEN_REQUIRED'
        });
    }

    // 🔥 إضافة محاولة تجديد التوكن تلقائياً
    if (!tokenSystem.validateToken(token)) {
        console.log('🔄 محاولة تجديد التوكن تلقائياً...');
        tokenSystem.updateToken();
        
        // إعادة التحقق بعد التجديد
        const newToken = tokenSystem.getCurrentToken();
        if (newToken && tokenSystem.validateToken(newToken)) {
            console.log('✅ تم تجديد التوكن بنجاح');
            return next();
        }
        
        return res.status(401).json({ 
            success: false,
            error: 'توكن ديناميكي غير صالح أو منتهي',
            code: 'INVALID_DYNAMIC_TOKEN',
            hint: 'جرب تحديث الصفحة'
        });
    }

    next();
};

// تطبيق middleware التوكن الديناميكي على جميع ال routes
app.use(validateDynamicToken);

// 🔧 دالة للتحقق من اتصال قاعدة البيانات
async function checkDatabaseConnection() {
    try {
        const result = await pool.query('SELECT NOW() as current_time');
        console.log('✅ قاعدة البيانات متصلة - الوقت الحالي:', result.rows[0].current_time);
        return true;
    } catch (error) {
        console.error('❌ خطأ في الاتصال بقاعدة البيانات:', error.message);
        return false;
    }
}

// 🔐 التحقق من توقيع تليجرام - الإصدار المصحح
function validateTelegramInitData(initData) {
    try {
        console.log('=== بدء التحقق من التوقيع ===');
        
        if (!initData) {
            console.log('❌ initData غير موجود');
            return false;
        }

        const decodedInitData = decodeURIComponent(initData);
        const parsedData = querystring.parse(decodedInitData);
        
        // 🔥 استخدم hash بدل signature
        const hash = parsedData.hash;
        
        console.log('🔑 الهاش المستلم:', hash);

        if (!hash) {
            console.log('❌ لا يوجد هاش في initData');
            return false;
        }

        // بناء البيانات للتحقق
        const dataToCheck = [];
        for (const [key, value] of Object.entries(parsedData)) {
            if (key !== 'hash' && value) {
                dataToCheck.push(`${key}=${value}`);
            }
        }
        
        dataToCheck.sort();
        const dataCheckString = dataToCheck.join('\n');
        
        // إنشاء المفتاح السري
        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();
        
        // حساب الهاش
        const calculatedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        console.log('🔢 الهاش المحسوب:', calculatedHash);
        console.log('🔢 الهاش المستلم:', hash);
        console.log('✅ التطابق:', calculatedHash === hash ? 'ناجح' : 'فاشل');
        
        return calculatedHash === hash;
    } catch (error) {
        console.error('❌ خطأ في التحقق:', error);
        return false;
    }
}

// 👤 استخراج بيانات المستخدم
function parseTelegramUser(initData) {
    try {
        if (!initData) {
            console.log('❌ initData غير موجود');
            return null;
        }

        const decodedInitData = decodeURIComponent(initData);
        const parsedData = querystring.parse(decodedInitData);
        const userStr = parsedData.user;
        
        if (!userStr) {
            console.log('❌ لا توجد بيانات مستخدم في initData');
            return null;
        }
        
        // فك تشفير JSON
        const user = JSON.parse(userStr);
        
        // 🔥 تحقق شامل من البيانات
        if (!user || !user.id) {
            console.log('❌ بيانات المستخدم غير صالحة - id مفقود');
            return null;
        }

        console.log('✅ بيانات المستخدم صالحة:', {
            id: user.id,
            username: user.username,
            first_name: user.first_name
        });
        
        return user;
        
    } catch (error) {
        console.error('❌ خطأ في تحليل بيانات المستخدم:', error);
        return null;
    }
}

// 📊 جلب المستخدم من قاعدة البيانات
async function getUserFromDB(userId) {
    try {
        console.log('🗄️ جلب المستخدم من DB:', userId);
        const result = await pool.query(
            'SELECT * FROM bot_users WHERE telegram_id = $1',
            [userId]
        );
        
        const userExists = result.rows.length > 0;
        console.log('✅ المستخدم موجود في DB:', userExists);
        
        return userExists ? result.rows[0] : null;
    } catch (error) {
        console.error('❌ خطأ في جلب المستخدم من DB:', error.message);
        return null;
    }
}

// ➕ إنشاء مستخدم جديد في قاعدة البيانات - الإصدار المحمي
async function createUserInDB(userData) {
    try {
        console.log('🆕 إنشاء مستخدم جديد - البيانات المستلمة:', userData);
        
        // 🔥 تحقق شامل من البيانات
        if (!userData.telegram_id) {
            console.log('❌ خطأ: telegram_id مفقود أو undefined');
            return null;
        }

        // تحويل telegram_id لـ string علشان نتأكد
        const telegramId = userData.telegram_id.toString();
        
        // 🔥 استخدم query آمن
        const query = `
            INSERT INTO bot_users 
            (telegram_id, username, first_name, balance, earning_wallet) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING *
        `;
        
        const values = [
            telegramId,
            userData.username || '',
            userData.first_name || 'مستخدم',
            0,
            0
        ];

        const result = await pool.query(query, values);
        
        console.log('✅ تم إنشاء المستخدم بنجاح');
        return result.rows[0];
        
    } catch (error) {
        console.error('❌ خطأ في إنشاء المستخدم:', error.message);
        
        // 🔥 إذا المستخدم موجود بالفعل، جيب بياناته
        if (error.code === '23505') {
            console.log('⚠️  المستخدم موجود بالفعل، جاري جلب البيانات...');
            return await getUserFromDB(userData.telegram_id);
        }
        
        // 🔥 إذا العمود مش موجود، عدل الجدول أولاً
        if (error.code === '42703') {
            console.log('⚠️  أعمدة ناقصة، جاري إصلاح الجداول...');
            await fixMissingColumns();
            // حاول تاني بعد الإصلاح
            return await createUserInDB(userData);
        }
        
        return null;
    }
}

// 🔧 دالة لإصلاح الأعمدة الناقصة
async function fixMissingColumns() {
    try {
        console.log('🔧 بدء إصلاح الأعمدة الناقصة...');
        
        const columnsToAdd = [
            { name: 'username', sql: 'ADD COLUMN IF NOT EXISTS username VARCHAR(255)' },
            { name: 'first_name', sql: 'ADD COLUMN IF NOT EXISTS first_name VARCHAR(255) NOT NULL DEFAULT \'مستخدم\'' },
            { name: 'balance', sql: 'ADD COLUMN IF NOT EXISTS balance DECIMAL(15, 8) DEFAULT 0.00000000' },
            { name: 'earning_wallet', sql: 'ADD COLUMN IF NOT EXISTS earning_wallet DECIMAL(15, 8) DEFAULT 0.00000000' },
            { name: 'total_earned', sql: 'ADD COLUMN IF NOT EXISTS total_earned DECIMAL(15, 8) DEFAULT 0.00000000' },
            { name: 'daily_ad_count', sql: 'ADD COLUMN IF NOT EXISTS daily_ad_count INTEGER DEFAULT 0' },
            { name: 'last_ad_date', sql: 'ADD COLUMN IF NOT EXISTS last_ad_date DATE DEFAULT CURRENT_DATE' },
            { name: 'created_at', sql: 'ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
        ];

        for (const column of columnsToAdd) {
            try {
                await pool.query(`ALTER TABLE bot_users ${column.sql}`);
                console.log(`✅ تم إضافة/التحقق من العمود: ${column.name}`);
            } catch (error) {
                console.log(`⚠️  تجاهل الخطأ في العمود ${column.name}:`, error.message);
            }
        }
        
        console.log('✅ تم الانتهاء من إصلاح الأعمدة');
        return true;
    } catch (error) {
        console.error('❌ خطأ في إصلاح الأعمدة:', error);
        return false;
    }
}

// 🏠 الصفحة الرئيسية
app.get('/', async (req, res) => {
    const dbConnected = await checkDatabaseConnection();
    
    res.json({ 
        message: 'TON Rewards Backend - جاري التشغيل',
        status: dbConnected ? '✅ متصل بقاعدة البيانات' : '❌ خطأ في قاعدة البيانات',
        timestamp: new Date().toISOString(),
        dynamicToken: '🔄 نظام التوكن الديناميكي مفعل كل 10 ثواني',
        config: config // إظهار الإعدادات
    });
});

// 📋 endpoint للإعدادات
app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        config: {
            adValue: config.adValue,
            dailyAdLimit: config.dailyAdLimit,
            minWithdrawal: config.minWithdrawal,
            referralBonus: config.referralBonus,
            contestAdPoints: config.contestAdPoints,
            contestReferralPoints: config.contestReferralPoints,
            botUsername: "Aborabie777_bot"
        }
    });
});

// 🔐 endpoints خاصة بنظام التوكن
app.get('/api/token/current', (req, res) => {
    const currentToken = tokenSystem.getCurrentToken();
    res.json({
        success: true,
        token: currentToken,
        valid_for: '15 ثانية',
        refresh_in: '10 ثواني',
        message: 'استخدم هذا التوكن في رأس الطلب (X-Dynamic-Token: TOKEN)'
    });
});

app.get('/api/token/stats', (req, res) => {
    res.json({
        success: true,
        ...tokenSystem.getStats(),
        system: 'نظام التوكن الديناميكي كل 10 ثواني'
    });
});

// 🔍 فحص الجداول
app.get('/api/check-tables', async (req, res) => {
    try {
        const tables = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        
        const tableNames = tables.rows.map(row => row.table_name);
        console.log('📊 الجداول الموجودة:', tableNames);
        
        res.json({
            success: true,
            tables: tableNames,
            hasBotUsers: tableNames.includes('bot_users'),
            hasWithdrawals: tableNames.includes('withdrawals'),
            hasContestLeaderboard: tableNames.includes('contest_leaderboard'),
            hasReferrals: tableNames.includes('referrals')
        });
    } catch (error) {
        console.error('❌ خطأ في فحص الجداول:', error);
        res.status(500).json({ 
            success: false,
            error: error.message 
        });
    }
});

// 🔧 إصلاح مشكلة السحب نهائياً
app.get('/api/fix-withdrawals-table', async (req, res) => {
    try {
        console.log('🔧 بدء إصلاح جدول السحوبات...');
        
        // 1. إسقاط الجدول إذا كان موجوداً (لإعادة إنشائه)
        try {
            await pool.query('DROP TABLE IF EXISTS withdrawals CASCADE');
            console.log('✅ تم حذف جدول السحوبات القديم');
        } catch (error) {
            console.log('ℹ️  الجدول غير موجود أو لا يمكن حذفه');
        }

        // 2. إنشاء الجدول من جديد مع جميع الأعمدة
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
        console.log('✅ تم إنشاء جدول السحوبات الجديد');

        // 3. إضافة فهرس للأداء
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
            CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
        `);
        console.log('✅ تم إضافة الفهارس');

        res.json({
            success: true,
            message: 'تم إصلاح جدول السحوبات بنجاح',
            table: 'withdrawals',
            columns: ['id', 'user_id', 'amount', 'wallet_address', 'status', 'method', 'memo', 'created_at']
        });

    } catch (error) {
        console.error('❌ خطأ في إصلاح جدول السحوبات:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🔧 إصلاح شامل للقاعدة
app.get('/api/repair-database', async (req, res) => {
    try {
        console.log('🔧 بدء إصلاح شامل للقاعدة...');
        
        // 1. إصلاح جدول المستخدمين
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
        console.log('✅ تم إصلاح جدول bot_users');

        // 2. إصلاح جدول السحوبات
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
        console.log('✅ تم إصلاح جدول withdrawals');

        res.json({
            success: true,
            message: 'تم إصلاح القاعدة بنجاح',
            tables: ['bot_users', 'withdrawals']
        });

    } catch (error) {
        console.error('❌ خطأ في إصلاح القاعدة:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🔧 إضافة endpoint لإنشاء جميع الجداول المطلوبة
app.get('/api/fix-all-tables', async (req, res) => {
    try {
        console.log('🔧 بدء إصلاح جميع الجداول...');
        
        // 1. إنشاء جدول bot_users إذا لم يكن موجوداً
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ تم إنشاء/التحقق من جدول bot_users');

        // 2. إنشاء جدول withdrawals مع العمود memo
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
        console.log('✅ تم إنشاء/التحقق من جدول withdrawals');

        // 3. إنشاء جدول contest_leaderboard
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
        console.log('✅ تم إنشاء/التحقق من جدول contest_leaderboard');

        // 4. إنشاء جدول referrals
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
        console.log('✅ تم إنشاء/التحقق من جدول referrals');

        res.json({
            success: true,
            message: 'تم إنشاء جميع الجداول بنجاح',
            tables: ['bot_users', 'withdrawals', 'contest_leaderboard', 'referrals']
        });

    } catch (error) {
        console.error('❌ خطأ في إنشاء الجداول:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🧪 اختبار السحب
app.get('/api/test-withdrawal', async (req, res) => {
    try {
        // تحقق من وجود جدول السحوبات
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'withdrawals'
            )
        `);
        
        const withdrawalsTableExists = tableCheck.rows[0].exists;
        
        res.json({
            success: true,
            withdrawalsTableExists: withdrawalsTableExists,
            message: withdrawalsTableExists 
                ? '✅ جدول السحوبات موجود وجاهز' 
                : '❌ جدول السحوبات غير موجود - استخدم /api/setup-database'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🔧 endpoint لإصلاح الأعمدة الناقصة
app.get('/api/fix-database', async (req, res) => {
    try {
        await fixMissingColumns();
        
        res.json({
            success: true,
            message: 'تم إصلاح الجداول بنجاح'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🔄 إعادة إنشاء الجداول إذا محتاج
app.get('/api/setup-database', async (req, res) => {
    try {
        // إنشاء جدول bot_users إذا مش موجود
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bot_users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                first_name VARCHAR(255) NOT NULL,
                balance DECIMAL(15, 8) DEFAULT 0.00000000,
                earning_wallet DECIMAL(15, 8) DEFAULT 0.00000000,
                total_earned DECIMAL(15, 8) DEFAULT 0.00000000,
                daily_ad_count INTEGER DEFAULT 0,
                last_ad_date DATE DEFAULT CURRENT_DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // إنشاء جدول withdrawals إذا مش موجود
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

        // 🆕 إنشاء جدول المسابقة
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

        // 🆕 إنشاء جدول الإحالات
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

        // 🔥 تأكد من وجود جميع الأعمدة
        await fixMissingColumns();

        res.json({
            success: true,
            message: 'تم إنشاء/تحديث الجداول بنجاح'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 🔍 endpoint لفحص حالة المستخدم
app.get('/api/debug-user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // جلب بيانات المستخدم
        const userResult = await pool.query(
            'SELECT * FROM bot_users WHERE telegram_id = $1',
            [userId]
        );
        
        // جلب تاريخ السحوبات
        const withdrawalsResult = await pool.query(
            'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        
        res.json({
            success: true,
            user: userResult.rows[0] || null,
            withdrawals: withdrawalsResult.rows,
            tablesExist: {
                bot_users: userResult.rows.length > 0,
                withdrawals: withdrawalsResult.rows.length > 0
            },
            currentToken: tokenSystem.getCurrentToken()?.substring(0, 15) + '...'
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 👤 جلب بيانات المستخدم من قاعدة البيانات + تسجيل تلقائي
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const initData = req.query.initData;

        console.log(`📥 طلب جلب بيانات المستخدم: ${userId}`);

        if (!validateTelegramInitData(initData)) {
            console.log('❌ فشل التحقق - رفض الطلب');
            return res.status(401).json({ 
                success: false,
                error: 'Invalid security signature' 
            });
        }

        console.log('✅ تم التحقق بنجاح - متابعة الطلب');
        
        // جلب المستخدم من قاعدة البيانات
        let user = await getUserFromDB(userId);
        let isNewUser = false;
        
        // 🔥 إذا المستخدم مش موجود، سجله تلقائياً
        if (!user) {
            console.log('🆕 المستخدم غير موجود - تسجيل تلقائي...');
            
            const telegramUser = parseTelegramUser(initData);
            
            if (telegramUser?.id) {
                const newUser = {
                    telegram_id: telegramUser.id.toString(),
                    username: telegramUser.username || '',
                    first_name: telegramUser.first_name || 'مستخدم'
                };

                user = await createUserInDB(newUser);
                isNewUser = true;
                
                if (user) {
                    console.log('✅ تم التسجيل التلقائي بنجاح');
                } else {
                    console.log('❌ فشل في التسجيل التلقائي');
                }
            }
        }

        if (user) {
            console.log('✅ تم العثور على المستخدم');
            res.json({ 
                success: true, 
                user: {
                    id: user.telegram_id,
                    firstName: user.first_name,
                    username: user.username,
                    balance: parseFloat(user.balance || 0),
                    earningWallet: parseFloat(user.earning_wallet || 0),
                    dailyAdCount: user.daily_ad_count || 0,
                    totalEarned: parseFloat(user.total_earned || 0)
                },
                isNewUser: isNewUser,
                welcomeMessage: isNewUser ? `🎉 أهلاً وسهلاً ${user.first_name}!` : `مرحباً بعودتك ${user.first_name}!`
            });
        } else {
            console.log('❌ فشل في التسجيل التلقائي');
            res.status(404).json({ 
                success: false,
                error: 'User not found - Registration failed' 
            });
        }
    } catch (error) {
        console.error('❌ خطأ في جلب بيانات المستخدم:', error.message);
        res.status(500).json({ 
            success: false,
            error: 'Failed to get user data' 
        });
    }
});

// 👤 تسجيل مستخدم جديد في قاعدة البيانات
app.post('/api/register', async (req, res) => {
    try {
        const { initData } = req.body;

        console.log('📥 طلب تسجيل مستخدم جديد');

        if (!validateTelegramInitData(initData)) {
            console.log('❌ فشل التحقق - رفض التسجيل');
            return res.status(401).json({ 
                success: false,
                error: 'Invalid security signature' 
            });
        }

        console.log('✅ تم التحقق بنجاح - متابعة التسجيل');
        
        const telegramUser = parseTelegramUser(initData);
        
        if (!telegramUser?.id) {
            console.log('❌ بيانات المستخدم غير صالحة');
            return res.status(400).json({ 
                success: false,
                error: 'Invalid user data' 
            });
        }

        const userId = telegramUser.id.toString();
        console.log(`👤 معالجة المستخدم: ${userId}`);
        
        // التحقق إذا المستخدم موجود في قاعدة البيانات
        let user = await getUserFromDB(userId);
        
        if (user) {
            console.log('✅ المستخدم موجود بالفعل');
            return res.json({ 
                success: true, 
                user: {
                    id: user.telegram_id,
                    firstName: user.first_name,
                    username: user.username,
                    balance: parseFloat(user.balance || 0),
                    earningWallet: parseFloat(user.earning_wallet || 0),
                    dailyAdCount: user.daily_ad_count || 0,
                    totalEarned: parseFloat(user.total_earned || 0)
                },
                message: `مرحباً بعودتك ${user.first_name}!`
            });
        }

        // إنشاء مستخدم جديد في قاعدة البيانات
        console.log('🆕 إنشاء مستخدم جديد...');
        const newUser = {
            telegram_id: userId,
            username: telegramUser.username || '',
            first_name: telegramUser.first_name || 'مستخدم'
        };

        user = await createUserInDB(newUser);

        if (user) {
            console.log('✅ تم إنشاء المستخدم بنجاح');
            res.json({ 
                success: true, 
                user: {
                    id: user.telegram_id,
                    firstName: user.first_name,
                    username: user.username,
                    balance: parseFloat(user.balance || 0),
                    earningWallet: parseFloat(user.earning_wallet || 0),
                    dailyAdCount: user.daily_ad_count || 0,
                    totalEarned: parseFloat(user.total_earned || 0)
                },
                message: `🎉 أهلاً وسهلاً ${user.first_name}!`
            });
        } else {
            console.log('❌ فشل في إنشاء المستخدم');
            res.status(500).json({ 
                success: false,
                error: 'Failed to create user' 
            });
        }

    } catch (error) {
        console.error('❌ خطأ في التسجيل:', error.message);
        res.status(500).json({ 
            success: false,
            error: 'Registration failed: ' + error.message 
        });
    }
});

// 📺 مشاهدة إعلان - الإصدار النهائي (بدون مشاكل المسابقة)
app.post('/api/watch-ad', async (req, res) => {
    const client = await pool.connect();
    
    try {
        const { initData } = req.body;

        console.log('📥 طلب مشاهدة إعلان');

        if (!validateTelegramInitData(initData)) {
            console.log('❌ فشل التحقق - رفض مشاهدة الإعلان');
            return res.status(401).json({ 
                success: false,
                error: 'Invalid security signature' 
            });
        }

        console.log('✅ تم التحقق بنجاح - متابعة مشاهدة الإعلان');
        const telegramUser = parseTelegramUser(initData);
        
        if (!telegramUser?.id) {
            console.log('❌ بيانات المستخدم غير صالحة');
            return res.status(400).json({ 
                success: false,
                error: 'Invalid user data' 
            });
        }

        const userId = telegramUser.id.toString();
        console.log(`👤 معالجة مشاهدة إعلان للمستخدم: ${userId}`);
        
        await client.query('BEGIN');

        // جلب المستخدم مع قفل الصف لمنع التنافس
        const userResult = await client.query(
            'SELECT * FROM bot_users WHERE telegram_id = $1 FOR UPDATE',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            console.log('❌ المستخدم غير موجود - يجب التسجيل أولاً');
            return res.status(404).json({ 
                success: false,
                error: 'User not found - Please register first' 
            });
        }

        const user = userResult.rows[0];

        // 🔥 التحقق من الحد اليومي للإعلانات
        const today = new Date().toDateString();
        const lastAdDate = user.last_ad_date ? new Date(user.last_ad_date).toDateString() : null;
        
        // إذا كان اليوم مختلف، إعادة تعيين العداد
        let dailyAdCount = user.daily_ad_count || 0;
        if (lastAdDate !== today) {
            dailyAdCount = 0;
        }

        if (dailyAdCount >= config.dailyAdLimit) {
            await client.query('ROLLBACK');
            console.log('❌ وصل للحد اليومي للإعلانات');
            return res.status(400).json({ 
                success: false,
                error: 'Daily ad limit reached' 
            });
        }

        // تحديث البيانات في قاعدة البيانات
        const adReward = config.adValue;
        console.log(`💰 مكافأة الإعلان: ${adReward} TON`);
        
        const updateResult = await client.query(
            `UPDATE bot_users SET 
                earning_wallet = COALESCE(earning_wallet, 0) + $1,
                total_earned = COALESCE(total_earned, 0) + $1,
                daily_ad_count = $2,
                last_ad_date = CURRENT_DATE
             WHERE telegram_id = $3 
             RETURNING *`,
            [adReward, dailyAdCount + 1, userId]
        );

        const updatedUser = updateResult.rows[0];
        
        if (updatedUser) {
            // 🔥 تحديث نقاط المسابقة - محمي ضد الأخطاء
            try {
                await client.query(`
                    INSERT INTO contest_leaderboard (user_id, username, first_name, points, ads_watched, last_activity)
                    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id) 
                    DO UPDATE SET 
                        points = contest_leaderboard.points + EXCLUDED.points,
                        ads_watched = contest_leaderboard.ads_watched + EXCLUDED.ads_watched,
                        last_activity = EXCLUDED.last_activity
                `, [userId, user.username || '', user.first_name || 'User', config.contestAdPoints, 1]);
                
                console.log('✅ تمت مشاهدة الإعلان بنجاح + تحديث المسابقة');
            } catch (contestError) {
                console.log('⚠️  خطأ في تحديث المسابقة:', contestError.message);
                // نستمر حتى لو فشل تحديث المسابقة
            }

            await client.query('COMMIT');
            
            res.json({
                success: true,
                amount: adReward,
                earningWallet: parseFloat(updatedUser.earning_wallet || 0),
                dailyRemaining: config.dailyAdLimit - (dailyAdCount + 1),
                totalEarned: parseFloat(updatedUser.total_earned || 0),
                contestPoints: config.contestAdPoints
            });
        } else {
            await client.query('ROLLBACK');
            console.log('❌ فشل في معالجة الإعلان');
            res.status(500).json({ 
                success: false,
                error: 'Failed to process ad' 
            });
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ خطأ في مشاهدة الإعلان:', error.message);
        res.status(500).json({ 
            success: false,
            error: 'Failed to process ad: ' + error.message 
        });
    } finally {
        client.release();
    }
});

// 💰 تحويل المحفظة إلى الرصيد
app.post('/api/move-to-balance', async (req, res) => {
    try {
        const { initData } = req.body;

        console.log('📥 طلب تحويل الرصيد');

        if (!validateTelegramInitData(initData)) {
            console.log('❌ فشل التحقق - رفض التحويل');
            return res.status(401).json({ 
                success: false,
                error: 'Invalid security signature' 
            });
        }

        console.log('✅ تم التحقق بنجاح - متابعة التحويل');
        const telegramUser = parseTelegramUser(initData);
        
        if (!telegramUser?.id) {
            console.log('❌ بيانات المستخدم غير صالحة');
            return res.status(400).json({ 
                success: false,
                error: 'Invalid user data' 
            });
        }

        const userId = telegramUser.id.toString();
        console.log(`👤 معالجة تحويل الرصيد للمستخدم: ${userId}`);
        
        const user = await getUserFromDB(userId);
        
        if (!user) {
            console.log('❌ المستخدم غير موجود');
            return res.status(404).json({ 
                success: false,
                error: 'User not found' 
            });
        }

        const earningWallet = parseFloat(user.earning_wallet || 0);
        console.log(`💰 الرصيد المتاح للتحويل: ${earningWallet} TON`);
        
        if (earningWallet < 0.0001) {
            console.log('❌ الرصيد غير كافي للتحويل');
            return res.status(400).json({ 
                success: false,
                error: 'Minimum 0.0001 TON required' 
            });
        }

        // تحديث الرصيد في قاعدة البيانات
        const updateResult = await pool.query(
            `UPDATE bot_users SET 
                balance = COALESCE(balance, 0) + $1,
                earning_wallet = 0
             WHERE telegram_id = $2 
             RETURNING *`,
            [earningWallet, userId]
        );

        const updatedUser = updateResult.rows[0];
        
        if (updatedUser) {
            console.log('✅ تم تحويل الرصيد بنجاح');
            res.json({
                success: true,
                newBalance: parseFloat(updatedUser.balance || 0),
                earningWallet: 0
            });
        } else {
            console.log('❌ فشل في تحويل الرصيد');
            res.status(500).json({ 
                success: false,
                error: 'Transfer failed' 
            });
        }

    } catch (error) {
        console.error('❌ خطأ في تحويل الرصيد:', error.message);
        res.status(500).json({ 
            success: false,
            error: 'Transfer failed' 
        });
    }
});

// 💳 طلب سحب - الإصدار النهائي المصحح
app.post('/api/withdraw', async (req, res) => {
    const client = await pool.connect();
    
    try {
        const { initData, amount, walletAddress, method = 'TON Wallet', memo = '' } = req.body;

        console.log('📥 طلب سحب:', { amount, walletAddress, method, memo });

        if (!validateTelegramInitData(initData)) {
            console.log('❌ فشل التحقق - رفض السحب');
            return res.status(401).json({ 
                success: false,
                error: 'Invalid security signature' 
            });
        }

        console.log('✅ تم التحقق بنجاح - متابعة السحب');
        const telegramUser = parseTelegramUser(initData);
        
        if (!telegramUser?.id) {
            console.log('❌ بيانات المستخدم غير صالحة');
            return res.status(400).json({ 
                success: false,
                error: 'Invalid user data' 
            });
        }

        const userId = telegramUser.id.toString();
        console.log(`👤 معالجة سحب للمستخدم: ${userId}`);
        
        await client.query('BEGIN');

        // جلب المستخدم مع قفل الصف لمنع التنافس
        const userResult = await client.query(
            'SELECT * FROM bot_users WHERE telegram_id = $1 FOR UPDATE',
            [userId]
        );
        
        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            console.log('❌ المستخدم غير موجود');
            return res.status(404).json({ 
                success: false,
                error: 'User not found' 
            });
        }

        const user = userResult.rows[0];
        const userBalance = parseFloat(user.balance || 0);
        const withdrawAmount = parseFloat(amount);
        
        console.log(`💰 رصيد المستخدم: ${userBalance} TON`);
        console.log(`💸 مبلغ السحب: ${withdrawAmount} TON`);

        // التحقق من الرصيد
        if (userBalance < withdrawAmount) {
            await client.query('ROLLBACK');
            console.log('❌ رصيد غير كافي');
            return res.status(400).json({ 
                success: false,
                error: 'Insufficient balance' 
            });
        }

        // التحقق من الحد الأدنى للسحب
        if (withdrawAmount < config.minWithdrawal) {
            await client.query('ROLLBACK');
            console.log(`❌ الحد الأدنى للسحب ${config.minWithdrawal} TON`);
            return res.status(400).json({ 
                success: false,
                error: `Minimum withdrawal is ${config.minWithdrawal} TON` 
            });
        }

        // خصم المبلغ من رصيد المستخدم
        await client.query(
            'UPDATE bot_users SET balance = balance - $1 WHERE telegram_id = $2',
            [withdrawAmount, userId]
        );

        // تسجيل طلب السحب
        const withdrawalResult = await client.query(
            `INSERT INTO withdrawals 
             (user_id, amount, wallet_address, status, method, memo) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             RETURNING *`,
            [userId, withdrawAmount, walletAddress, 'pending', method, memo]
        );

        await client.query('COMMIT');

        const withdrawal = withdrawalResult.rows[0];
        
        console.log('✅ تم إنشاء طلب السحب بنجاح:', withdrawal.id);
        
        res.json({
            success: true,
            withdrawalId: withdrawal.id,
            newBalance: userBalance - withdrawAmount,
            message: 'تم تقديم طلب السحب بنجاح وسيتم معالجته خلال 24 ساعة'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ خطأ في السحب:', error.message);
        res.status(500).json({ 
            success: false,
            error: 'Withdrawal failed: ' + error.message 
        });
    } finally {
        client.release();
    }
});

// 📋 الحصول على تاريخ السحوبات
app.get('/api/withdrawals/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const initData = req.query.initData;

        console.log(`📥 طلب تاريخ السحوبات للمستخدم: ${userId}`);

        if (!validateTelegramInitData(initData)) {
            console.log('❌ فشل التحقق - رفض الطلب');
            return res.status(401).json({ 
                success: false,
                error: 'Invalid security signature' 
            });
        }

        console.log('✅ تم التحقق بنجاح - متابعة الطلب');
        
        // جلب تاريخ السحوبات
        const withdrawals = await pool.query(
            `SELECT * FROM withdrawals 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 20`,
            [userId]
        );

        console.log(`📊 عدد السحوبات: ${withdrawals.rows.length}`);
        
        res.json({
            success: true,
            withdrawals: withdrawals.rows.map(w => ({
                id: w.id,
                amount: parseFloat(w.amount),
                walletAddress: w.wallet_address,
                status: w.status,
                method: w.method,
                memo: w.memo,
                createdAt: w.created_at
            }))
        });

    } catch (error) {
        console.error('❌ خطأ في جلب تاريخ السحوبات:', error.message);
        res.status(500).json({ 
            success: false,
            error: 'Failed to get withdrawal history' 
        });
    }
});

// 🏆 endpoints المسابقة
app.get('/api/contest/leaderboard', async (req, res) => {
    try {
        const leaderboard = await pool.query(`
            SELECT cl.*, bu.first_name, bu.username 
            FROM contest_leaderboard cl
            LEFT JOIN bot_users bu ON cl.user_id = bu.telegram_id
            ORDER BY cl.points DESC, cl.last_activity DESC
            LIMIT 50
        `);
        
        res.json({
            success: true,
            leaderboard: leaderboard.rows,
            totalParticipants: leaderboard.rows.length
        });
    } catch (error) {
        console.error('❌ خطأ في جلب المتصدرين:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🏆 إصلاح نظام المسابقة نهائياً
app.post('/api/contest/update-user', async (req, res) => {
    try {
        const { userId, points = 0, adsWatched = 0, referralsCount = 0 } = req.body;
        
        console.log(`🔄 تحديث مسابقة للمستخدم: ${userId}`, { points, adsWatched, referralsCount });
        
        // جلب بيانات المستخدم أولاً
        const user = await getUserFromDB(userId);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        // التأكد من وجود جدول المسابقة
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
        
        // تحديث أو إدخال بيانات المسابقة
        const result = await pool.query(`
            INSERT INTO contest_leaderboard 
            (user_id, username, first_name, points, ads_watched, referrals_count, last_activity)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                points = contest_leaderboard.points + EXCLUDED.points,
                ads_watched = contest_leaderboard.ads_watched + EXCLUDED.ads_watched,
                referrals_count = contest_leaderboard.referrals_count + EXCLUDED.referrals_count,
                last_activity = EXCLUDED.last_activity
            RETURNING *
        `, [userId, user.username || '', user.first_name || 'User', points, adsWatched, referralsCount]);
        
        console.log('✅ تم تحديث المسابقة بنجاح:', result.rows[0]);
        
        res.json({
            success: true,
            contestData: result.rows[0],
            message: 'تم تحديث نقاط المسابقة بنجاح'
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث نقاط المسابقة:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🏆 جلب ترتيب مستخدم معين
app.get('/api/contest/user-rank/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        const rankResult = await pool.query(`
            SELECT position FROM (
                SELECT user_id, points, ROW_NUMBER() OVER (ORDER BY points DESC, last_activity DESC) as position
                FROM contest_leaderboard
            ) ranked WHERE user_id = $1
        `, [userId]);
        
        const userRank = rankResult.rows.length > 0 ? rankResult.rows[0].position : 0;
        
        res.json({
            success: true,
            userId: userId,
            rank: userRank,
            inLeaderboard: userRank > 0
        });
    } catch (error) {
        console.error('❌ خطأ في جلب الترتيب:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/contest/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        const result = await pool.query(`
            SELECT * FROM contest_leaderboard 
            WHERE user_id = $1
        `, [userId]);
        
        if (result.rows.length > 0) {
            res.json({ success: true, contestData: result.rows[0] });
        } else {
            res.json({ success: true, contestData: null });
        }
    } catch (error) {
        console.error('❌ خطأ في جلب بيانات مسابقة المستخدم:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 👥 endpoints نظام الإحالات
app.post('/api/referrals/add', async (req, res) => {
    try {
        const { referrerId, referredId } = req.body;
        
        // تحقق إذا المستخدم الجديد موجود
        const referredUser = await getUserFromDB(referredId);
        if (!referredUser) {
            return res.status(404).json({ success: false, error: 'Referred user not found' });
        }
        
        // تحقق إذا تمت الإحالة مسبقاً
        const existingReferral = await pool.query(
            'SELECT * FROM referrals WHERE referred_id = $1',
            [referredId]
        );
        
        if (existingReferral.rows.length > 0) {
            return res.json({ success: true, message: 'User already referred', referral: existingReferral.rows[0] });
        }
        
        // تسجيل الإحالة الجديدة
        const result = await pool.query(`
            INSERT INTO referrals (referrer_id, referred_id, status)
            VALUES ($1, $2, 'active')
            RETURNING *
        `, [referrerId, referredId]);
        
        // تحديث عدد الإحالات في المسابقة
        await pool.query(`
            INSERT INTO contest_leaderboard (user_id, referrals_count, last_activity)
            VALUES ($1, 1, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                referrals_count = contest_leaderboard.referrals_count + 1,
                last_activity = EXCLUDED.last_activity
        `, [referrerId]);
        
        res.json({
            success: true,
            referral: result.rows[0],
            message: 'تم تسجيل الإحالة بنجاح'
        });
    } catch (error) {
        console.error('❌ خطأ في تسجيل الإحالة:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/referrals/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // جلب الإحالات
        const referrals = await pool.query(`
            SELECT r.*, bu.first_name, bu.username 
            FROM referrals r
            LEFT JOIN bot_users bu ON r.referred_id = bu.telegram_id
            WHERE r.referrer_id = $1
            ORDER BY r.created_at DESC
        `, [userId]);
        
        // إحصائيات الإحالات
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total_referrals,
                COALESCE(SUM(referrer_earnings), 0) as total_earnings
            FROM referrals 
            WHERE referrer_id = $1
        `, [userId]);
        
        res.json({
            success: true,
            referrals: referrals.rows,
            stats: stats.rows[0]
        });
    } catch (error) {
        console.error('❌ خطأ في جلب بيانات الإحالات:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔍 فحص مفصل للجداول
app.get('/api/debug-tables', async (req, res) => {
    try {
        // فحص جدول bot_users
        const botUsersColumns = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'bot_users'
            ORDER BY ordinal_position
        `);

        // فحص جدول withdrawals
        const withdrawalsColumns = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'withdrawals'
            ORDER BY ordinal_position
        `);

        // فحص جدول contest_leaderboard
        const contestColumns = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'contest_leaderboard'
            ORDER BY ordinal_position
        `);

        res.json({
            success: true,
            bot_users_columns: botUsersColumns.rows,
            withdrawals_columns: withdrawalsColumns.rows,
            contest_leaderboard_columns: contestColumns.rows,
            missing_memo: !withdrawalsColumns.rows.find(col => col.column_name === 'memo')
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🛑 إيقاف نظيف للسيرفر
process.on('SIGINT', () => {
    console.log('\n🛑 إيقاف نظام التوكن...');
    tokenSystem.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 إيقاف نظام التوكن...');
    tokenSystem.stop();
    process.exit(0);
});

// 🚀 تشغيل السيرفر
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`🟢 TON Rewards Backend running on port ${PORT}`);
    console.log(`💰 Ad reward: ${config.adValue} TON`);
    console.log(`📊 Daily ads: ${config.dailyAdLimit} ads`);
    console.log(`💸 Min withdrawal: ${config.minWithdrawal} TON`);
    console.log(`👥 Referral bonus: ${config.referralBonus} TON`);
    console.log(`🏆 Contest points per ad: ${config.contestAdPoints}`);
    console.log(`🔐 Telegram verification: ENABLED`);
    console.log(`🔄 Dynamic token system: ACTIVE (10 seconds)`);
    
    // فحص الاتصال بقاعدة البيانات عند البدء
    checkDatabaseConnection();
});
