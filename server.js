// Cloudflare Worker لـ GLX Galaxy
export default {
    async fetch(request, env, ctx) {
        // إعداد CORS
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, X-User-ID, X-Telegram-Data, X-Action, X-Device-Fingerprint, X-Client-IP, X-Captcha-Token',
                }
            });
        }
        
        const url = new URL(request.url);
        const path = url.pathname;
        
        // التحقق من المسار
        if (path !== '/api') {
            return new Response(JSON.stringify({
                success: false,
                error: 'Invalid endpoint'
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        try {
            // استخراج البيانات من الطلب
            const requestData = await request.json();
            const action = request.headers.get('X-Action') || requestData.action;
            const data = requestData.data || {};
            const userId = request.headers.get('X-User-ID');
            const telegramData = request.headers.get('X-Telegram-Data');
            const deviceFingerprint = request.headers.get('X-Device-Fingerprint') || data.deviceFingerprint;
            const clientIp = request.headers.get('X-Client-IP') || request.headers.get('CF-Connecting-IP') || 'Unknown';
            const captchaToken = request.headers.get('X-Captcha-Token') || data.captchaToken;
            
            console.log(`Request received: action=${action}, userId=${userId}, clientIp=${clientIp}`);
            
            // التحقق من المصادقة
            if (!userId || !telegramData) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Authentication required',
                    errorCode: 'AUTH_REQUIRED'
                }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            // التحقق من بيانات Telegram
            if (!isValidTelegramData(telegramData, userId)) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Invalid Telegram data',
                    errorCode: 'INVALID_TELEGRAM_DATA'
                }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            // ==================== نظام بصمة الجهاز المحسن بدون IP ====================
            // التحقق من بصمة الجهاز فقط لإجراء initializeUser
            if (action === 'initializeUser') {
                // جلب بيانات المستخدم أولاً للتحقق مما إذا كان جديدًا
                const userResult = await handleDbGet(env, `users/${userId}`);
                const userData = userResult.data;
                
                // إذا كان المستخدم جديدًا (لا توجد بيانات) أو ليس لديه بصمة جهاز
                if ((!userResult.success || !userData || !userData.deviceFingerprint) && deviceFingerprint) {
                    // التحقق مما إذا كانت بصمة الجهاز مستخدمة بالفعل
                    const fingerprintCheck = await checkDeviceFingerprintWithoutIP(env, deviceFingerprint, userId);
                    
                    if (fingerprintCheck.deviceAlreadyUsed) {
                        // الحساب الحالي هو حساب جديد، يتم حظره لأنه ليس الحساب الأول
                        await applyBlock(env, userId, {
                            reason: 'Device multi-account violation - New account detected',
                            violation: 'DEVICE_MULTI_ACCOUNT',
                            action: 'initializeUser',
                            details: `Device fingerprint ${deviceFingerprint} already used by ${fingerprintCheck.existingAccounts.length} other accounts`,
                            timestamp: Date.now(),
                            permanent: true,
                            deviceFingerprint: deviceFingerprint,
                            isNewAccount: true
                        });
                        
                        return new Response(JSON.stringify({
                            success: false,
                            error: 'ACCOUNT_BLOCKED',
                            errorCode: 'DEVICE_MULTI_ACCOUNT_BLOCKED',
                            data: {
                                deviceAlreadyUsed: true,
                                existingAccounts: fingerprintCheck.existingAccounts,
                                violationType: 'DEVICE_MULTI_ACCOUNT',
                                accountsBlocked: fingerprintCheck.newAccountsBlocked,
                                currentAccountBlocked: true,
                                blockedMessage: `🚫 Account Blocked\n\nReason: Device multi-account violation\nViolation: DEVICE_MULTI_ACCOUNT\n\nThis decision is final.`,
                                redirectToBlockPage: true
                            }
                        }), {
                            status: 403,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    
                    // إذا لم تكن البصمة مستخدمة، سنقوم بحفظها لاحقًا في handleInitializeUser
                    data.deviceFingerprint = deviceFingerprint;
                }
            }
            // ==================== نهاية نظام بصمة الجهاز ====================
            
            // ==================== نظام الحظر التلقائي ====================
            // التحقق من الحظر قبل معالجة أي طلب
            const blockCheck = await checkUserBlocked(env, userId);
            if (blockCheck && blockCheck.isBlocked) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'ACCOUNT_BLOCKED',
                    errorCode: 'ACCOUNT_BLOCKED',
                    data: {
                        isBlocked: true,
                        blockDetails: {
                            reason: blockCheck.reason,
                            violation: blockCheck.violation,
                            appliedAt: blockCheck.appliedAt,
                            permanent: blockCheck.permanent,
                            details: blockCheck.details,
                            blockType: blockCheck.permanent ? 'PERMANENT_BLOCK' : 'TEMPORARY_BLOCK'
                        },
                        blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\nDetails: ${blockCheck.details}\n\nThis decision is final.`,
                        redirectToBlockPage: true
                    }
                }), {
                    status: 403,
                    headers: { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }
            
            // ✅ ✅ ✅ تعديل مطلوب: إلغاء نظام الحظر التلقائي على "تلاعب الريكويستات"
            // (زي قيم المكافآت) بالكامل. السبب: أي قيمة حساسة (مكافأة، رصيد، ...)
            // المفروض أصلًا متتحسبش أو تتحفظ اعتمادًا على قيمة جاية من العميل -
            // كل الهاندلرز (handleAdClick, handlePromoCode, ...) بتجيب القيمة الصح
            // من إعدادات السيرفر / قاعدة البيانات مباشرة وبتتجاهل أي قيمة العميل
            // بعتها. يعني حتى لو حد لعب في الريكويست، أقصى حاجة ممكنة تحصل إن
            // الطلب يترفض برسالة خطأ عادية - من غير ما نحظر الحساب نهائيًا.
            // ده بيمنع أي حظر خاطئ (false positive) بسبب فرق بسيط في التوقيت أو
            // مشكلة شبكة عابرة، وبيخلي الأمان الحقيقي في مكانه الصح: السيرفر.
            const validationResult = await validateRequest(env, userId, action, data, requestData.timestamp, captchaToken);
            if (!validationResult.valid) {
                // رفض الطلب فقط - بدون أي تسجيل مخالفة أو حظر تلقائي
                return new Response(JSON.stringify({
                    success: false,
                    error: 'REQUEST_VALIDATION_FAILED',
                    errorCode: validationResult.violation,
                    data: {
                        details: validationResult.details,
                        noBlock: true,
                        message: 'Request validation failed. Please try again.'
                    }
                }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            
            // ==================== نهاية نظام التحقق من الطلبات ====================
            
            // معالجة الإجراءات
            let result;
            switch (action) {
                case 'initializeUser':
                    result = await handleInitializeUser(env, userId, data, telegramData);
                    break;
                    
                case 'getCompetitionData':
                    result = await handleGetCompetitionData(env, userId);
                    break;
                    
                case 'dbSet':
                    result = await handleDbSet(env, data.path, data.data);
                    break;
                    
                case 'dbGet':
                    result = await handleDbGet(env, data.path);
                    break;
                    
                case 'dbUpdate':
                    result = await handleDbUpdate(env, data.path, data.updates);
                    break;
                    
                case 'dbPush':
                    result = await handleDbPush(env, data.path, data.data);
                    break;
                    
                case 'dbTransaction':
                    result = await handleDbTransaction(env, data.path, data.transactionFunction);
                    break;
                    
                case 'dbIncrement':
                    result = await handleDbIncrement(env, data.path, data.key, data.amount);
                    break;
                    
                case 'getConfig':
                    result = await handleGetConfig(env);
                    break;
                    
                case 'updateAppSettings':
                    result = await handleUpdateAppSettings(env, userId, data);
                    break;
                    
                case 'executeSwap':
                    result = await handleExecuteSwap(env, userId, data);
                    break;
                    
                case 'verifyDeposit':
                    result = await handleVerifyDeposit(env, userId, data);
                    break;
                    
                case 'buyTickets':
                    result = await handleBuyTickets(env, userId, data);
                    break;
                    
                case 'getCompetitionLeaderboard':
                    result = await handleGetCompetitionLeaderboard(env);
                    break;
                    
                case 'getPreviousWinners':
                    result = await handleGetPreviousWinners(env);
                    break;
                    
                case 'flipCoin':
                    result = await handleFlipCoin(env, userId, data);
                    break;
                    
                case 'redeemPromoCode':
                    result = await handleRedeemPromoCode(env, userId, data);
                    break;
                    
                case 'createTask':
                    result = await handleCreateTask(env, userId, data);
                    break;
                    
                case 'verifyTaskPayment':
                    result = await handleVerifyTaskPayment(env, data.taskId);
                    break;
                    
                case 'verifyTaskChannel':
                    result = await handleVerifyTaskChannel(env, userId, data);
                    break;
                    
                case 'spinSlots':
                    result = await handleSpinSlots(env, userId);
                    break;
                    
                case 'addExtraSpin':
                    result = await handleAddExtraSpin(env, userId);
                    break;
                    
                case 'claimDailyBonus':
                    result = await handleClaimDailyBonus(env, userId);
                    break;
                    
                case 'getTransactionHistory':
                    result = await handleGetTransactionHistory(env, userId, data.limit);
                    break;
                    
                case 'getUserWithdrawals':
                    result = await handleGetUserWithdrawals(env, userId);
                    break;
                    
                case 'getWithdrawalHistory':
                    result = await handleGetWithdrawalHistory(env);
                    break;
                    
                case 'getWithdrawalStats':
                    result = await handleGetWithdrawalStats(env);
                    break;
                    
                case 'getReferredUsers':
                    result = await handleGetReferredUsers(env, userId);
                    break;
                    
                case 'getTasks':
                    result = await handleGetTasks(env, userId);
                    break;
                    
                case 'verifyTaskCompletion':
                    result = await handleVerifyTaskCompletion(env, userId, data);
                    break;
                    
                case 'handleReferral':
                    result = await handleReferral(env, data.userId, data.referrerId);
                    break;
                    
                case 'handleAdClick':
                    // التحقق من الحظر قبل معالجة طلب الإعلان
                    const adBlockCheck = await checkUserBlocked(env, userId);
                    if (adBlockCheck && adBlockCheck.isBlocked) {
                        return new Response(JSON.stringify({
                            success: false,
                            error: 'ACCOUNT_BLOCKED',
                            errorCode: 'ACCOUNT_BLOCKED',
                            data: {
                                isBlocked: true,
                                blockDetails: adBlockCheck,
                                blockedMessage: `🚫 Account Blocked\n\nReason: ${adBlockCheck.reason}\nViolation: ${adBlockCheck.violation}\n\nThis decision is final.`,
                                redirectToBlockPage: true
                            }
                        }), {
                            status: 403,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    
                    // ✅ تعديل: التحقق من صحة طلب الإعلان بيرفض الطلب الغير صالح فقط
                    // من غير أي حظر تلقائي - القيمة الحقيقية للمكافأة بتتحسب وبتتضاف
                    // من إعدادات السيرفر فقط جوه handleAdClick، مش من قيمة العميل،
                    // فمفيش داعي لحظر المستخدم حتى لو حاول يبعت قيمة مختلفة.
                    const adValidation = await validateAdRequest(env, userId, data, captchaToken);
                    if (!adValidation.valid) {
                        return new Response(JSON.stringify({
                            success: false,
                            error: 'REQUEST_VALIDATION_FAILED',
                            errorCode: adValidation.violation || 'AD_VALIDATION_FAILED',
                            data: {
                                details: adValidation.details,
                                noBlock: true,
                                message: 'Request validation failed. Please try again.'
                            }
                        }), {
                            status: 400,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                    
                    result = await handleAdClick(env, userId, data.adType, data.reward, captchaToken);
                    break;
                    
                case 'submitWithdrawal':
                    // ✅ حد السحب اليومي معطّل
                    result = await handleSubmitWithdrawal(env, userId, data);
                    break;
                    
                case 'getDailyWithdrawalInfo':
                    result = await handleGetDailyWithdrawalInfo(env, userId);
                    break;
                    
                case 'getLeaderboard':
                    result = await handleGetLeaderboard(env);
                    break;
                    
                case 'testFirebase':
                    result = await handleTestFirebase(env);
                    break;
                    
                case 'getUserData':
                    result = await handleGetUserData(env, userId);
                    break;
                    
                case 'refreshCompetition':
                    result = await handleRefreshCompetition(env);
                    break;
                    
                case 'verifyTelegramMembership':
                    result = await handleVerifyTelegramMembership(env, userId, data);
                    break;
                    
                case 'syncUserCompetitionTickets':
                    result = await handleSyncUserCompetitionTickets(env, userId);
                    break;
                    
                case 'checkDeviceFingerprint':
                    result = await handleCheckDeviceFingerprint(env, userId, data);
                    break;
                    
                case 'saveDeviceFingerprint':
                    result = await handleSaveDeviceFingerprint(env, userId, data);
                    break;
                    
                case 'periodicDeviceCheck':
                    result = await handlePeriodicDeviceCheck(env, userId, data);
                    break;
                    
                case 'getClientIP':
                    result = await handleGetClientIP(clientIp);
                    break;
                    
                case 'testTelegramApi':
                    result = await handleTestTelegramApi(env, userId, data);
                    break;
                    
                case 'migrateWithdrawals':
                    result = await migrateWithdrawals(env);
                    break;
                    
                case 'getAllPromoCodes':
                    result = await handleGetAllPromoCodes(env);
                    break;
                    
                case 'getActivePromoCodes':
                    result = await handleGetActivePromoCodes(env);
                    break;
                    
                case 'createPromoCode':
                    result = await handleCreatePromoCode(env, userId, data);
                    break;
                    
                case 'verifyMandatoryChannels':
                    result = await handleVerifyMandatoryChannels(env, userId);
                    break;
                    
                case 'checkMandatorySubscriptions':
                    result = await handleCheckMandatorySubscriptions(env, userId);
                    break;
                    
                case 'verifyCaptcha':
                    result = await handleVerifyCaptcha(env, captchaToken);
                    break;
                    
                case 'getAdStats':
                    result = await handleGetAdStats(env, userId);
                    break;
                    
                default:
                    result = {
                        success: false,
                        error: 'Unknown action',
                        errorCode: 'UNKNOWN_ACTION'
                    };
            }
            
            // إرجاع النتيجة
            return new Response(JSON.stringify(result), {
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
            
        } catch (error) {
            console.error('Worker error:', error);
            
            return new Response(JSON.stringify({
                success: false,
                error: 'Internal server error',
                errorCode: 'INTERNAL_SERVER_ERROR',
                details: error.message,
                stack: error.stack
            }), {
                status: 500,
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        }
    }
};

// ==================== نظام Captcha بعد كل 10 إعلانات ====================

// التحقق من رمز Captcha
async function verifyCaptchaToken(env, captchaToken) {
    try {
        if (!captchaToken) {
            return { valid: false, error: 'Captcha token is required' };
        }
        
        const secretKey = '0x4AAAAAACOf6iTNX4O5_WP9Kt07Kimr8FU';
        
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `secret=${secretKey}&response=${captchaToken}`
        });
        
        const data = await response.json();
        console.log("Captcha verification result:", data);
        
        if (data.success) {
            return { valid: true };
        } else {
            return { 
                valid: false, 
                error: 'Invalid captcha token',
                errorDetails: data['error-codes'] || []
            };
        }
    } catch (error) {
        console.error("Captcha verification error:", error);
        return { 
            valid: false, 
            error: 'Captcha verification failed',
            details: error.message
        };
    }
}

// التحقق مما إذا كان المستخدم يحتاج إلى كابتشا
async function requiresCaptcha(env, userId, adType) {
    try {
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { requiresCaptcha: false };
        }
        
        const userData = userResult.data;
        const today = new Date().toDateString();
        
        // إذا لم يكن اليوم هو نفس اليوم الأخير، إعادة التعيين
        if (userData.lastAdDate !== today) {
            return { requiresCaptcha: false };
        }
        
        // حساب عدد الإعلانات اليوم
        const adCountToday = userData.adsWatched || 0;
        
        const settings = await getOrInitAppSettings(env);
        const threshold = settings.captchaThreshold ?? 10;
        const captchaCooldown = settings.captchaCooldown ?? 30000;
        
        // إذا شاهد العدد المحدد في الإعدادات من الإعلانات أو أكثر اليوم، يحتاج كابتشا
        if (adCountToday >= threshold) {
            // التحقق مما إذا كان قد مر وقت كافي منذ آخر كابتشا
            const lastCaptchaTime = userData.lastCaptchaTime || 0;
            
            if (Date.now() - lastCaptchaTime < captchaCooldown) {
                return { 
                    requiresCaptcha: true,
                    cooldown: true,
                    remainingCooldown: captchaCooldown - (Date.now() - lastCaptchaTime)
                };
            }
            
            return { requiresCaptcha: true };
        }
        
        return { requiresCaptcha: false };
    } catch (error) {
        console.error("Error checking captcha requirement:", error);
        return { requiresCaptcha: false };
    }
}

// معالجة التحقق من Captcha
async function handleVerifyCaptcha(env, captchaToken) {
    try {
        const captchaResult = await verifyCaptchaToken(env, captchaToken);
        
        if (!captchaResult.valid) {
            return {
                success: false,
                error: captchaResult.error,
                errorCode: 'INVALID_CAPTCHA',
                data: {
                    errorDetails: captchaResult.errorDetails
                }
            };
        }
        
        return {
            success: true,
            data: {
                verified: true,
                message: "Captcha verified successfully",
                timestamp: Date.now()
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'CAPTCHA_VERIFICATION_ERROR'
        };
    }
}

// معالجة الحصول على إحصائيات الإعلانات
async function handleGetAdStats(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        const today = new Date().toDateString();
        
        // جلب إعدادات الحدود
        const configResult = await handleGetConfig(env);
        const settings = configResult.data?.settings || {};
        const threshold = settings.captchaThreshold ?? 10;
        
        // حساب عدد الإعلانات اليوم
        const adCountToday = (userData.lastAdDate === today) ? userData.adsWatched || 0 : 0;
        const requiresCaptcha = adCountToday >= threshold;
        
        return {
            success: true,
            data: {
                adsWatchedToday: adCountToday,
                requiresCaptcha: requiresCaptcha,
                captchaThreshold: threshold,
                remainingBeforeCaptcha: Math.max(0, threshold - adCountToday),
                limits: {
                    monetag: settings.limitMonetag || 50,
                    giga: settings.limitGiga || 300,
                    adsgram: settings.limitAdsgram || 300,
                    totalToday: settings.limitMonetag + settings.limitGiga + settings.limitAdsgram || 650
                },
                today: today,
                lastAdDate: userData.lastAdDate,
                siteKey: settings.captchaSiteKey || '0x4AAAAAACOf6mYyukJx5XVy' // Site Key للكابتشا
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_AD_STATS_ERROR'
        };
    }
}

// ==================== نظام بصمة الجهاز المحسن بدون الاعتماد على IP ====================

// التحقق مما إذا كانت بصمة الجهاز مستخدمة مسبقًا (بدون النظر إلى الـ IP)
async function checkDeviceFingerprintWithoutIP(env, deviceFingerprint, currentUserId = null) {
    try {
        if (!deviceFingerprint) {
            return { deviceAlreadyUsed: false };
        }
        
        // البحث في جميع المستخدمين عن بصمة الجهاز
        const usersResult = await handleDbGet(env, 'users');
        const usersData = usersResult.data || {};
        
        let existingAccounts = [];
        let oldestAccount = null;
        let oldestJoinDate = Infinity;
        let newAccountsBlocked = 0;
        
        // البحث عن جميع الحسابات المرتبطة بنفس الجهاز
        for (const [userId, userData] of Object.entries(usersData)) {
            // تخطي المستخدم الحالي إذا كان موجودًا
            if (currentUserId && userId === currentUserId) continue;
            
            if (userData.deviceFingerprint === deviceFingerprint) {
                const accountInfo = {
                    userId: userId,
                    name: userData.name || 'Anonymous User',
                    photoUrl: userData.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png',
                    joinDate: userData.joinDate,
                    lastLogin: userData.lastLogin,
                    isBlocked: userData.isBlocked || false
                };
                
                existingAccounts.push(accountInfo);
                
                // تحديد أقدم حساب
                if (userData.joinDate && userData.joinDate < oldestJoinDate) {
                    oldestJoinDate = userData.joinDate;
                    oldestAccount = userId;
                }
            }
        }
        
        if (existingAccounts.length > 0) {
            console.log(`Found ${existingAccounts.length} existing accounts for device ${deviceFingerprint}`);
            console.log(`Oldest account: ${oldestAccount} with join date: ${new Date(oldestJoinDate).toISOString()}`);
            
            // حظر جميع الحسابات الجديدة فقط (عدا الحساب الأول/الأقدم)
            for (const account of existingAccounts) {
                // إذا لم يكن هذا الحساب هو الأقدم ولم يكن محظورًا بالفعل
                if (account.userId !== oldestAccount && !account.isBlocked) {
                    await applyBlock(env, account.userId, {
                        reason: 'Device multi-account violation - Secondary account detected',
                        violation: 'DEVICE_MULTI_ACCOUNT',
                        action: 'deviceFingerprintCheck',
                        details: `Device fingerprint ${deviceFingerprint} already used by primary account ${oldestAccount}`,
                        timestamp: Date.now(),
                        permanent: true,
                        deviceFingerprint: deviceFingerprint,
                        isNewAccount: true
                    });
                    
                    newAccountsBlocked++;
                    console.log(`Blocked secondary account: ${account.userId}`);
                }
            }
            
            return {
                deviceAlreadyUsed: true,
                existingAccounts: existingAccounts,
                primaryAccount: oldestAccount,
                newAccountsBlocked: newAccountsBlocked,
                violationType: 'DEVICE_MULTI_ACCOUNT',
                accountsCount: existingAccounts.length,
                primaryAccountProtected: true
            };
        }
        
        return { deviceAlreadyUsed: false };
    } catch (error) {
        console.error('Error checking device fingerprint:', error);
        return { deviceAlreadyUsed: false };
    }
}

// التحقق من صحة بصمة الجهاز (تنسيق SHA-256)
function validateFingerprintFormat(fingerprint) {
    if (!fingerprint || typeof fingerprint !== 'string') {
        return { valid: false, error: 'Fingerprint is required' };
    }
    
    // التحقق من التنسيق (SHA-256: 64 حرفاً hex)
    const sha256Regex = /^[a-f0-9]{64}$/i;
    if (!sha256Regex.test(fingerprint)) {
        return { valid: false, error: 'Invalid fingerprint format. Must be 64-character SHA-256 hash' };
    }
    
    return { valid: true };
}

// معالجة التحقق من بصمة الجهاز
async function handleCheckDeviceFingerprint(env, userId, data) {
    try {
        const { deviceFingerprint } = data;
        
        if (!deviceFingerprint) {
            return {
                success: false,
                error: 'Device fingerprint is required',
                errorCode: 'DEVICE_FINGERPRINT_REQUIRED'
            };
        }
        
        // التحقق من صحة التنسيق
        const formatValidation = validateFingerprintFormat(deviceFingerprint);
        if (!formatValidation.valid) {
            return {
                success: false,
                error: formatValidation.error,
                errorCode: 'INVALID_FINGERPRINT_FORMAT'
            };
        }
        
        const fingerprintCheck = await checkDeviceFingerprintWithoutIP(env, deviceFingerprint, userId);
        
        // إذا كان الجهاز مستخدمًا، التحقق مما إذا كان المستخدم الحالي هو الحساب الأول
        if (fingerprintCheck.deviceAlreadyUsed) {
            // إذا كان المستخدم الحالي ليس الحساب الأول، يتم حظره
            if (fingerprintCheck.primaryAccount !== userId) {
                await applyBlock(env, userId, {
                    reason: 'Device multi-account violation - New account detected',
                    violation: 'DEVICE_MULTI_ACCOUNT',
                    action: 'checkDeviceFingerprint',
                    details: `Device fingerprint ${deviceFingerprint} already used by ${fingerprintCheck.existingAccounts.length} other accounts`,
                    timestamp: Date.now(),
                    permanent: true,
                    deviceFingerprint: deviceFingerprint,
                    isNewAccount: true
                });
                
                return {
                    success: false,
                    error: 'ACCOUNT_BLOCKED',
                    errorCode: 'DEVICE_MULTI_ACCOUNT_BLOCKED',
                    data: {
                        deviceAlreadyUsed: true,
                        existingAccounts: fingerprintCheck.existingAccounts,
                        primaryAccount: fingerprintCheck.primaryAccount,
                        isPrimaryAccount: false,
                        violationType: 'DEVICE_MULTI_ACCOUNT',
                        accountsBlocked: fingerprintCheck.newAccountsBlocked + 1,
                        currentAccountBlocked: true,
                        blockedMessage: `🚫 Account Blocked\n\nReason: Device multi-account violation\nViolation: DEVICE_MULTI_ACCOUNT\n\nThis decision is final.`,
                        redirectToBlockPage: true
                    }
                };
            } else {
                // المستخدم الحالي هو الحساب الأول، لا يتم حظره
                return {
                    success: true,
                    data: {
                        deviceAlreadyUsed: true,
                        existingAccounts: fingerprintCheck.existingAccounts,
                        primaryAccount: fingerprintCheck.primaryAccount,
                        isPrimaryAccount: true,
                        newAccountsBlocked: fingerprintCheck.newAccountsBlocked,
                        message: 'You are the primary account on this device. Your account is protected.'
                    }
                };
            }
        }
        
        return {
            success: true,
            data: fingerprintCheck
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'DEVICE_CHECK_ERROR'
        };
    }
}

// معالجة حفظ بصمة الجهاز
async function handleSaveDeviceFingerprint(env, userId, data) {
    try {
        const { deviceFingerprint } = data;
        
        if (!deviceFingerprint) {
            return {
                success: false,
                error: 'Device fingerprint is required',
                errorCode: 'DEVICE_FINGERPRINT_REQUIRED'
            };
        }
        
        // التحقق من صحة التنسيق
        const formatValidation = validateFingerprintFormat(deviceFingerprint);
        if (!formatValidation.valid) {
            return {
                success: false,
                error: formatValidation.error,
                errorCode: 'INVALID_FINGERPRINT_FORMAT'
            };
        }
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // التحقق من أن المستخدم موجود
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        // التحقق مما إذا كانت البصمة مستخدمة بالفعل من قبل مستخدم آخر
        const fingerprintCheck = await checkDeviceFingerprintWithoutIP(env, deviceFingerprint, userId);
        
        if (fingerprintCheck.deviceAlreadyUsed) {
            // إذا كان المستخدم الحالي ليس الحساب الأول، يتم حظره
            if (fingerprintCheck.primaryAccount !== userId) {
                // حظر الحساب الحالي فورًا
                await applyBlock(env, userId, {
                    reason: 'Device multi-account violation',
                    violation: 'DEVICE_MULTI_ACCOUNT',
                    action: 'saveDeviceFingerprint',
                    details: 'Attempt to use device registered with another account',
                    timestamp: Date.now(),
                    permanent: true,
                    deviceFingerprint: deviceFingerprint,
                    isNewAccount: true
                });
                
                return {
                    success: false,
                    error: 'ACCOUNT_BLOCKED',
                    errorCode: 'DEVICE_MULTI_ACCOUNT_BLOCKED',
                    data: {
                        deviceAlreadyUsed: true,
                        existingAccounts: fingerprintCheck.existingAccounts,
                        primaryAccount: fingerprintCheck.primaryAccount,
                        isPrimaryAccount: false,
                        violationType: 'DEVICE_MULTI_ACCOUNT',
                        accountsBlocked: fingerprintCheck.newAccountsBlocked + 1,
                        currentAccountBlocked: true,
                        blockedMessage: `🚫 Account Blocked\n\nReason: Device multi-account violation\nViolation: DEVICE_MULTI_ACCOUNT\n\nThis decision is final.`,
                        redirectToBlockPage: true
                    }
                };
            }
        }
        
        // تحديث المستخدم بإضافة بصمة الجهاز
        const updateData = {
            deviceFingerprint: deviceFingerprint,
            deviceRegisteredAt: Date.now(),
            lastDeviceCheck: Date.now(),
            deviceInfo: data.deviceInfo || {},
            deviceLoginCount: (userData.deviceLoginCount || 0) + 1,
            lastUpdated: Date.now()
        };
        
        await handleDbUpdate(env, `users/${userId}`, updateData);
        
        // حفظ في سجل الأجهزة
        await handleDbPush(env, 'devices/registry', {
            deviceFingerprint: deviceFingerprint,
            userId: userId,
            registeredAt: Date.now(),
            userAgent: data.userAgent || 'Unknown',
            deviceInfo: data.deviceInfo || {}
        });
        
        return {
            success: true,
            data: {
                message: 'Device fingerprint saved successfully',
                deviceRegisteredAt: Date.now(),
                deviceValidated: true
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'DEVICE_SAVE_ERROR'
        };
    }
}

// معالجة الفحص الدوري للجهاز
async function handlePeriodicDeviceCheck(env, userId, data) {
    try {
        const { deviceFingerprint } = data;
        
        if (!deviceFingerprint) {
            return {
                success: false,
                error: 'Device fingerprint is required',
                errorCode: 'DEVICE_FINGERPRINT_REQUIRED'
            };
        }
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // التحقق من صحة التنسيق
        const formatValidation = validateFingerprintFormat(deviceFingerprint);
        if (!formatValidation.valid) {
            return {
                success: false,
                error: formatValidation.error,
                errorCode: 'INVALID_FINGERPRINT_FORMAT'
            };
        }
        
        // التحقق من بصمة الجهاز
        const fingerprintCheck = await checkDeviceFingerprintWithoutIP(env, deviceFingerprint, userId);
        
        if (fingerprintCheck.deviceAlreadyUsed) {
            // إذا كان المستخدم الحالي ليس الحساب الأول، يتم حظره
            if (fingerprintCheck.primaryAccount !== userId) {
                // حظر الحساب الحالي فورًا
                await applyBlock(env, userId, {
                    reason: 'Session multi-account violation',
                    violation: 'PERIODIC_DEVICE_MULTI_ACCOUNT',
                    action: 'periodicDeviceCheck',
                    details: 'Multiple accounts detected from same device during session',
                    timestamp: Date.now(),
                    permanent: true,
                    deviceFingerprint: deviceFingerprint,
                    isNewAccount: true
                });
                
                return {
                    success: true,
                    data: {
                        securityViolation: true,
                        deviceAlreadyUsed: true,
                        existingAccounts: fingerprintCheck.existingAccounts,
                        primaryAccount: fingerprintCheck.primaryAccount,
                        isPrimaryAccount: false,
                        violationType: 'SESSION_MULTI_ACCOUNT_DETECTED',
                        actionRequired: 'SESSION_TERMINATION',
                        currentAccountBlocked: true,
                        blockedMessage: `🚫 Account Blocked\n\nReason: Session multi-account violation\nViolation: PERIODIC_DEVICE_MULTI_ACCOUNT\n\nThis decision is final.`,
                        redirectToBlockPage: true
                    }
                };
            }
        }
        
        // تحديث وقت آخر فحص
        await handleDbUpdate(env, `users/${userId}`, {
            lastPeriodicCheck: Date.now(),
            deviceCheckCount: (data.deviceCheckCount || 0) + 1,
            lastUpdated: Date.now()
        });
        
        return {
            success: true,
            data: {
                securityViolation: false,
                lastCheck: Date.now()
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'PERIODIC_CHECK_ERROR'
        };
    }
}

// ==================== نظام التحقق من الاشتراك الإجباري في القنوات ====================

// التحقق من الاشتراك في القنوات الإجبارية
async function checkMandatorySubscriptions(env, userId) {
    try {
        const settings = await getOrInitAppSettings(env);

        // لو الأدمن عطّل الاشتراك الإجباري من الإعدادات، بنعتبر الكل مشترك
        if (settings.mandatorySubscriptionEnabled === false) {
            return {
                success: true,
                allSubscribed: true,
                subscriptionStatus: {},
                missingChannels: []
            };
        }

        const requiredChannels = settings.mandatoryChannels || [];

        if (requiredChannels.length === 0) {
            return {
                success: true,
                allSubscribed: true,
                subscriptionStatus: {},
                missingChannels: []
            };
        }
        
        const subscriptionStatus = {};
        const missingChannels = [];
        
        for (const channel of requiredChannels) {
            try {
                const isMember = await checkTelegramMembershipDirect(env, userId, channel);
                subscriptionStatus[channel] = isMember;
                
                if (!isMember) {
                    missingChannels.push(channel);
                    // تسجيل المحاولة
                    await logSubscriptionAttempt(env, userId, channel, false);
                }
            } catch (error) {
                console.error(`Error checking channel ${channel}:`, error);
                subscriptionStatus[channel] = false;
                missingChannels.push(channel);
            }
        }
        
        // التحقق إذا كان مشتركاً في جميع القنوات
        const allSubscribed = Object.values(subscriptionStatus).every(status => status === true);
        
        return {
            success: allSubscribed,
            allSubscribed: allSubscribed,
            subscriptionStatus: subscriptionStatus,
            missingChannels: missingChannels
        };
    } catch (error) {
        console.error('Error in mandatory subscription check:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// التحقق المباشر من عضوية Telegram
async function checkTelegramMembershipDirect(env, userId, channelUsername) {
    try {
        const botToken = env.TELEGRAM_BOT_TOKEN || '7066931017:AAHwuXbgaKHNrHrbf6jaoC8LDk0lSCPimgI';
        
        if (!botToken) {
            console.error('Bot token not configured');
            return false;
        }
        
        // تنظيف اسم القناة
        let cleanChannelUsername = channelUsername;
        
        if (cleanChannelUsername.includes('t.me/')) {
            cleanChannelUsername = cleanChannelUsername.split('t.me/')[1];
        }
        
        if (cleanChannelUsername.startsWith('@')) {
            cleanChannelUsername = cleanChannelUsername.substring(1);
        }
        
        const chatMemberUrl = `https://api.telegram.org/bot${botToken}/getChatMember`;
        
        const response = await fetch(chatMemberUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: `@${cleanChannelUsername}`,
                user_id: parseInt(userId)
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Telegram API error for ${cleanChannelUsername}:`, errorText);
            return false;
        }
        
        const result = await response.json();
        
        return result.ok && 
            (result.result.status === 'member' || 
             result.result.status === 'administrator' || 
             result.result.status === 'creator');
        
    } catch (error) {
        console.error('Telegram membership check error:', error);
        return false;
    }
}

// تسجيل محاولة الاشتراك
async function logSubscriptionAttempt(env, userId, channel, success) {
    try {
        await handleDbPush(env, `subscriptionAttempts/${userId}`, {
            channel: channel,
            success: success,
            timestamp: Date.now(),
            userId: userId
        });
        return true;
    } catch (error) {
        console.error('Error logging subscription attempt:', error);
        return false;
    }
}

// معالجة التحقق من القنوات الإجبارية
async function handleVerifyMandatoryChannels(env, userId) {
    // ✅ تفعيل الفحص الحقيقي (كانت الدالة دي كمان معطّلة ودايمًا بترجع true)
    try {
        const subscriptionResult = await checkMandatorySubscriptions(env, userId);
        return {
            success: subscriptionResult.allSubscribed === true,
            data: {
                allSubscribed: subscriptionResult.allSubscribed === true,
                subscriptionStatus: subscriptionResult.subscriptionStatus,
                missingChannels: subscriptionResult.missingChannels || []
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'VERIFY_MANDATORY_CHANNELS_ERROR'
        };
    }
}

// معالجة التحقق من الاشتراك الإجباري
async function handleCheckMandatorySubscriptions(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // ✅ تفعيل الفحص الحقيقي للاشتراك الإجباري في القنوات
        const subscriptionResult = await checkMandatorySubscriptions(env, userId);

        if (!subscriptionResult.success && subscriptionResult.error) {
            // خطأ فعلي أثناء الفحص (وليس مجرد عدم اشتراك) - لا نمنع المستخدم بسبب خطأ تقني
            return subscriptionResult;
        }

        return {
            success: subscriptionResult.allSubscribed === true,
            data: {
                allSubscribed: subscriptionResult.allSubscribed === true,
                subscriptionStatus: subscriptionResult.subscriptionStatus,
                missingChannels: subscriptionResult.missingChannels || []
            },
            ...(subscriptionResult.allSubscribed !== true && {
                error: 'MANDATORY_SUBSCRIPTION_REQUIRED',
                errorCode: 'MANDATORY_SUBSCRIPTION_REQUIRED'
            })
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'CHECK_MANDATORY_SUBSCRIPTIONS_ERROR'
        };
    }
}

// ==================== نظام الحظر التلقائي المحسن ====================

// التحقق من صحة الطلب
async function validateRequest(env, userId, action, data, requestTimestamp, captchaToken) {
    const now = Date.now();
    const MAX_TIME_DIFF = 120000; // 2 دقيقة كحد أقصى للفرق الزمني
    
    // 1. التحقق من الطابع الزمني فقط إذا كان موجودًا
    if (requestTimestamp) {
        const timeDiff = Math.abs(now - parseInt(requestTimestamp));
        
        // إذا كان الفرق كبيرًا جدًا (أكثر من 2 دقيقة)، نرفض الطلب لكن بدون حظر
        if (timeDiff > MAX_TIME_DIFF) {
            return {
                valid: false,
                violation: 'TIMESTAMP_EXPIRED',
                details: `Timestamp difference too large: ${timeDiff}ms (max ${MAX_TIME_DIFF}ms)`,
                shouldBlock: false // لا حظر، فقط رفض الطلب
            };
        }
        
        // التحقق من استخدام نفس الطابع الزمني مسبقًا
        const isDuplicate = await checkDuplicateTimestamp(env, userId, requestTimestamp);
        if (isDuplicate) {
            // الحظر فقط لمشاهدة الإعلانات، للباقي خطأ فقط
            if (action === 'handleAdClick') {
                return {
                    valid: false,
                    violation: 'DUPLICATE_TIMESTAMP',
                    details: 'Timestamp already used - potential replay attack',
                    shouldBlock: true // هذا فقط الذي يستحق الحظر
                };
            } else {
                return {
                    valid: false,
                    violation: 'DUPLICATE_TIMESTAMP',
                    details: 'Timestamp already used - please try again',
                    shouldBlock: false // خطأ فقط
                };
            }
        }
    }
    
    // 2. التحقق من قيم المكافآت بناءً على نوع الإجراء
    if (action === 'handleAdClick') {
        return await validateAdRequest(env, userId, data, captchaToken);
    }
    
    if (action === 'redeemPromoCode') {
        return await validatePromoCodeRequest(env, userId, data);
    }
    
    if (action === 'verifyTaskCompletion') {
        return await validateTaskRequest(env, userId, data);
    }
    
    if (action === 'buyTickets') {
        return await validateTicketPurchase(env, userId, data);
    }
    
    if (action === 'flipCoin') {
        return await validateCoinFlip(env, userId, data);
    }
    
    if (action === 'spinSlots') {
        return await validateSlotSpin(env, userId);
    }
    
    if (action === 'claimDailyBonus') {
        return await validateDailyBonus(env, userId);
    }
    
    // 3. التحقق من صحة المهام والمكافآت
    if (action === 'verifyTaskCompletion' || action === 'verifyTaskChannel') {
        return await validateTaskReward(env, userId, data, action);
    }
    
    // 4. التحقق من متطلبات الإجراءات الحساسة
    if (action === 'submitWithdrawal') {
        return await validateWithdrawalRequest(env, userId, data);
    }
    
    if (action === 'executeSwap') {
        return await validateSwapRequest(env, userId, data);
    }
    
    if (action === 'verifyDeposit') {
        return await validateDepositRequest(env, userId, data);
    }
    
    return { valid: true };
}

// التحقق من صحة طلب الإعلان
async function validateAdRequest(env, userId, data, captchaToken) {
    const { adType, reward } = data;
    
    // جلب الإعدادات للتحقق من القيم الصحيحة
    const configResult = await handleGetConfig(env);
    const settings = configResult.data?.settings || {};
    
    // القيم المسموح بها لكل نوع إعلان (جميعها 500 عملة فقط)
    const allowedRewards = {
        'monetag': 500,
        'giga': 500,
        'adsgram': 500
    };
    
    // التحقق من وجود نوع الإعلان
    if (!allowedRewards[adType]) {
        return {
            valid: false,
            violation: 'INVALID_AD_TYPE',
            details: `Invalid ad type: ${adType}`
        };
    }
    
    // التحقق من قيمة المكافأة (يجب أن تطابق القيمة في الإعدادات بالضبط)
    const allowedReward = allowedRewards[adType];
    const requestedReward = parseInt(reward);
    
    if (requestedReward !== allowedReward) {
        return {
            valid: false,
            violation: 'REWARD_MANIPULATION',
            details: `Ad reward manipulation: Expected ${allowedReward}, got ${requestedReward}`
        };
    }
    
    // التحقق من الحد الأقصى للإعلانات اليومية
    const userResult = await handleDbGet(env, `users/${userId}`);
    if (userResult.success && userResult.data) {
        const userData = userResult.data;
        const adCountField = `ads${adType.charAt(0).toUpperCase() + adType.slice(1)}`;
        
        // جلب الحد الأقصى من الإعدادات
        const adLimitField = `limit${adType.charAt(0).toUpperCase() + adType.slice(1)}`;
        const limit = settings[adLimitField] || 50;
        
        if (userData[adCountField] >= limit) {
            return {
                valid: false,
                violation: 'AD_LIMIT_EXCEEDED',
                details: `Ad limit exceeded for ${adType}`
            };
        }
    }
    
    // ==================== التحقق من Captcha إذا لزم الأمر ====================
    const captchaCheck = await requiresCaptcha(env, userId, adType);
    if (captchaCheck.requiresCaptcha) {
        if (captchaCheck.cooldown) {
            return {
                valid: false,
                violation: 'CAPTCHA_COOLDOWN',
                details: `Captcha cooldown active. Please wait ${Math.ceil(captchaCheck.remainingCooldown / 1000)} seconds`,
                shouldBlock: false
            };
        }
        
        if (!captchaToken) {
            return {
                valid: false,
                violation: 'CAPTCHA_REQUIRED',
                details: 'Captcha verification required after 10 ads today',
                shouldBlock: false
            };
        }
        
        // التحقق من صحة Captcha
        const captchaResult = await verifyCaptchaToken(env, captchaToken);
        if (!captchaResult.valid) {
            // تحديث وقت آخر محاولة كابتشا
            if (userResult.success && userResult.data) {
                await handleDbUpdate(env, `users/${userId}`, {
                    lastCaptchaTime: Date.now(),
                    lastUpdated: Date.now()
                });
            }
            
            return {
                valid: false,
                violation: 'INVALID_CAPTCHA',
                details: captchaResult.error,
                shouldBlock: false
            };
        }
    }
    
    return { valid: true };
}

// ==================== نظام الحد اليومي للسحوبات ====================

// التحقق من الحد اليومي للسحوبات
async function checkDailyWithdrawalLimit(env, userId) {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // جلب جميع السحوبات اليومية من withdrawQueue (عقدة البوت الفعلية)
        const withdrawalsResult = await handleDbGet(env, 'withdrawQueue');
        const queueData = withdrawalsResult.data || {};
        
        let todayWithdrawals = 0;
        
        // حساب سحوبات المستخدم اليوم — كل الحالات ما عدا الملغية/الفاشلة
        for (const [key, withdrawal] of Object.entries(queueData)) {
            const ts = withdrawal.ts || withdrawal.timestamp || 0;
            if (withdrawal.userId === userId &&
                ts >= today.getTime() &&
                ts < tomorrow.getTime() &&
                !['cancelled', 'failed'].includes(withdrawal.status)) {
                todayWithdrawals++;
            }
        }
        
        const settings = await getOrInitAppSettings(env);
        const dailyLimit = settings.withdrawalLimitEnabled === false
            ? 999999
            : (settings.dailyWithdrawalLimit ?? 2);
        
        return {
            todayWithdrawals: todayWithdrawals,
            dailyLimit: dailyLimit,
            limitReached: todayWithdrawals >= dailyLimit,
            remaining: Math.max(0, dailyLimit - todayWithdrawals),
            resetTime: tomorrow.getTime()
        };
    } catch (error) {
        console.error('Error checking daily withdrawal limit:', error);
        return {
            todayWithdrawals: 0,
            dailyLimit: 2,
            limitReached: false,
            remaining: 2,
            resetTime: Date.now() + 86400000
        };
    }
}

// الحصول على معلومات الحد اليومي للسحوبات
async function handleGetDailyWithdrawalInfo(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const limitInfo = await checkDailyWithdrawalLimit(env, userId);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        return {
            success: true,
            data: {
                todayWithdrawals: limitInfo.todayWithdrawals,
                dailyLimit: limitInfo.dailyLimit,
                remaining: limitInfo.remaining,
                resetTime: tomorrow.toLocaleString(),
                resetTimestamp: tomorrow.getTime(),
                resetIn: tomorrow.getTime() - Date.now(),
                canWithdraw: limitInfo.remaining > 0
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_DAILY_WITHDRAWAL_INFO_ERROR'
        };
    }
}

// ==================== دوال الإعدادات والمكافآت المعدلة ====================
// ✅ كل الأرقام دي بقت قابلة للتعديل من الفاير باس (settings/appConfig).
// لو المسار ده فاضي في قاعدة البيانات (أول مرة)، بننشئه تلقائيًا بنفس القيم
// الافتراضية المستخدمة حاليًا، وبعد كده أي تعديل من لوحة التحكم بيتقرأ من هنا.
const DEFAULT_APP_SETTINGS = {
    // مكافآت الإعلانات - جميعها 500 عملة فقط
    adRewardMonetag: 500,
    adRewardGiga: 500,
    adRewardAdsgram: 500,
    
    // حدود الإعلانات اليومية (كام إعلان مسموح لكل شركة في اليوم)
    limitMonetag: 50,
    limitGiga: 300,
    limitAdsgram: 300,
    
    // سعر التذكرة
    ticketPrice: 10000, // سعر التذكرة الواحدة = 10,000 GLX
    maxTicketsPerPurchase: 100,
    minTicketsPerPurchase: 1,
    
    // حدود السحب
    minTonWithdrawal: 0.05,
    minFaucetPayWithdrawal: 0.0001,
    
    // نظام الإحالة - 100,000 GLX
    referralReward: 100000,
    
    // أسعار أخرى
    pricePerClick: 0.0015,
    
    // سعر التحويل بين العملة الداخلية (TSK/GLX) والـ TON
    // tskToTonRate: قيمة الـ TON مقابل 1 TSK. tonToTskRate: قيمة الـ TSK مقابل 1 TON
    tskToTonRate: 0.0000001,
    tonToTskRate: 10000000,
    
    // مكافآت تسجيل الدخول اليومي (تسلسل حسب عدد أيام الاستمرار)
    dailyRewards: [2000, 3000, 5000, 7000, 9000, 12000, 15000],
    
    // معلومات البوت
    botUsername: '@testtt1257bot',
    botWallet: 'UQB2IqqJtC8NtRgxksq80c_FC8RqShxpGDKA3e4aJFwjvwgv',
    botToken: '7066931017:AAHwuXbgaKHNrHrbf6jaoC8LDk0lSCPimgI',
    
    // نظام الحظر
    maxTimestampDiff: 120000, // 2 دقيقة كحد أقصى
    maxViolations: 1, // مخالفة واحدة فقط للحظر
    blockDuration: 0, // حظر دائم
    instantBlock: true, // حظر فوري بعد مخالفة واحدة
    
    // Coin Flip limits
    coinFlipMinBet: 1000, // الحد الأدنى للرهان
    coinFlipMaxBet: 100000, // الحد الأقصى للرهان
    coinFlipDailyLimit: 1000000, // الحد الأقصى اليومي للمكاسب
    
    // مكافآت المهام
    taskChannelReward: 2000, // مكافأة الانضمام للقناة
    maxTaskReward: 20000, // الحد الأقصى لمكافأة المهمة
    
    // حدود البرومو كود
    maxPromoReward: 10000, // الحد الأقصى لمكافأة البرومو كود
    
    // نظام بصمة الجهاز
    enableDeviceFingerprint: true, // تفعيل نظام التحقق من بصمة الجهاز
    allowMultipleDevices: false, // عدم السماح بأجهزة متعددة لنفس المستخدم
    deviceCheckRequired: true, // التحقق من الجهاز مطلوب للمستخدمين الجدد
    
    // إعدادات الأمان
    periodicDeviceCheckInterval: 30000, // فحص دوري كل 30 ثانية
    enableIpTracking: false, // إيقاف تتبع عناوين IP
    multiAccountDetection: true, // كشف الحسابات المتعددة
    multiAccountAutoBlock: true, // حظر تلقائي للحسابات المتعددة
    protectPrimaryAccount: true, // حماية الحساب الأول فقط
    
    // نظام الحد اليومي للسحوبات
    dailyWithdrawalLimit: 2, // سحبتين في اليوم
    withdrawalLimitEnabled: true, // تفعيل نظام الحد اليومي
    
    // القنوات الإجبارية (الاشتراك الإجباري)
    mandatoryChannels: [
        'earnmoney174688',
        'earnmoney1685', 
        'earnmoney139482',
        'EarnMoneyWithRedone'
    ],
    mandatorySubscriptionEnabled: true,
    
    // نظام Captcha
    captchaSiteKey: '0x4AAAAAACOf6mYyukJx5XVy',
    captchaSecretKey: '0x4AAAAAACOf6iTNX4O5_WP9Kt07Kimr8FU',
    captchaThreshold: 10, // بعد 10 إعلانات يطلب كابتشا
    captchaCooldown: 30000, // 30 ثانية بين محاولات الكابتشا
    
    // نظام الإعلانات
    adRewardFixed: 500, // المكافأة الثابتة للإعلانات
    enableAdCaptcha: true // تفعيل نظام الكابتشا للإعلانات
};

// ✅ بتجيب الإعدادات من الفاير باس، ولو أول مرة (المسار فاضي) بتنشئه بالقيم
// الافتراضية فوق وترجعها. لو فيه إعدادات محفوظة بالفعل بس ناقصها مفاتيح جديدة
// (مثلاً بعد إضافة ميزة جديدة)، بندمجها مع الافتراضي عشان محدش يتكسر.
async function getOrInitAppSettings(env) {
    try {
        const settingsResult = await handleDbGet(env, 'settings/appConfig');
        
        if (!settingsResult.success) {
            console.error('Failed to read settings/appConfig, falling back to defaults:', settingsResult.error);
            return { ...DEFAULT_APP_SETTINGS };
        }
        
        const savedSettings = settingsResult.data;
        
        if (!savedSettings || Object.keys(savedSettings).length === 0) {
            // أول مرة - ننشئ الإعدادات الافتراضية في قاعدة البيانات
            console.log('settings/appConfig not found - seeding with default values');
            const seedResult = await handleDbSet(env, 'settings/appConfig', DEFAULT_APP_SETTINGS);
            if (!seedResult.success) {
                console.error('Failed to seed default settings:', seedResult.error);
            }
            return { ...DEFAULT_APP_SETTINGS };
        }
        
        // دمج: أي مفتاح موجود في القاعدة بيغلب الافتراضي، وأي مفتاح جديد
        // مش موجود لسه في القاعدة بياخد قيمته الافتراضية تلقائيًا
        return { ...DEFAULT_APP_SETTINGS, ...savedSettings };
    } catch (error) {
        console.error('getOrInitAppSettings error, falling back to defaults:', error);
        return { ...DEFAULT_APP_SETTINGS };
    }
}

async function handleGetConfig(env) {
    try {
        const settings = await getOrInitAppSettings(env);
        
        return {
            success: true,
            data: { settings }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_CONFIG_ERROR'
        };
    }
}

// ✅ تحديث إعدادات التطبيق من لوحة التحكم - بيقبل تحديث جزئي (أي عدد من
// المفاتيح) وبيدمجها مع الموجود بدل ما يمسح باقي الإعدادات.
// ⚠️ محمي بمفتاح إداري (env.ADMIN_SECRET) لأن الأرقام دي حساسة (مكافآت،
// أسعار، حدود سحب...) ولازم محدش غير المشرف يقدر يعدّلها.
async function handleUpdateAppSettings(env, userId, data) {
    try {
        const { adminSecret, updates } = data;
        
        const expectedSecret = env.ADMIN_SECRET;
        if (!expectedSecret || adminSecret !== expectedSecret) {
            return {
                success: false,
                error: 'Unauthorized',
                errorCode: 'ADMIN_UNAUTHORIZED'
            };
        }
        
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return {
                success: false,
                error: 'updates object is required',
                errorCode: 'INVALID_SETTINGS_UPDATE'
            };
        }
        
        // نتأكد إن الإعدادات موجودة أصلاً (وننشئها بالافتراضي لو أول مرة) قبل التحديث
        await getOrInitAppSettings(env);
        
        const updateResult = await handleDbUpdate(env, 'settings/appConfig', updates);
        if (!updateResult.success) {
            return {
                success: false,
                error: updateResult.error,
                errorCode: 'SETTINGS_UPDATE_FAILED'
            };
        }
        
        const newSettings = await getOrInitAppSettings(env);
        
        return {
            success: true,
            data: { settings: newSettings }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'UPDATE_APP_SETTINGS_ERROR'
        };
    }
}

// ==================== دالة handleAdClick المعدلة مع نظام Captcha ====================

async function handleAdClick(env, userId, adType, reward, captchaToken = null) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        const adCountField = `ads${capitalizeFirstLetter(adType)}`;
        const currentCount = userData[adCountField] || 0;
        
        // ✅ المكافأة المتوقعة والحد اليومي بيتقروا من إعدادات الفاير باس دلوقتي
        // بدل ما يبقوا أرقام ثابتة، عشان لو الأدمن غيّر مكافأة إعلان معين
        // (مثلاً adRewardMonetag) القبول والرصيد المُضاف يتحدثوا مع بعض.
        const configResult = await handleGetConfig(env);
        const settings = configResult.data?.settings || {};
        const rewardField = `adReward${capitalizeFirstLetter(adType)}`;
        const expectedReward = settings[rewardField] ?? settings.adRewardFixed ?? 500;
        
        if (parseInt(reward) !== expectedReward) {
            return {
                success: false,
                error: 'Invalid reward amount',
                errorCode: 'INVALID_AD_REWARD',
                data: {
                    expected: expectedReward,
                    received: reward
                }
            };
        }
        
        // التحقق من الحدود اليومية
        const limit = settings[`limit${capitalizeFirstLetter(adType)}`] || 50;
        
        if (currentCount >= limit) {
            return {
                success: false,
                error: 'Daily limit reached',
                errorCode: 'AD_LIMIT_EXCEEDED',
                data: {
                    currentCount: currentCount,
                    limit: limit,
                    adType: adType
                }
            };
        }
        
        // التحقق من عدد الإعلانات اليومية واحتياج الكابتشا
        const today = new Date().toDateString();
        let adsWatchedToday = 0;
        
        // إذا كان اليوم مختلف، إعادة التعيين
        if (userData.lastAdDate !== today) {
            adsWatchedToday = 1;
        } else {
            adsWatchedToday = (userData.adsWatched || 0) + 1;
        }
        
        // إذا شاهد العدد المحدد في الإعدادات من الإعلانات أو أكثر، يطلب كابتشا
        const adCaptchaThreshold = settings.captchaThreshold ?? 10;
        if (adsWatchedToday >= adCaptchaThreshold) {
            if (!captchaToken) {
                return {
                    success: false,
                    error: 'CAPTCHA_REQUIRED',
                    errorCode: 'CAPTCHA_REQUIRED',
                    data: {
                        adsWatchedToday: adsWatchedToday,
                        captchaThreshold: adCaptchaThreshold,
                        siteKey: settings.captchaSiteKey || '0x4AAAAAACOf6mYyukJx5XVy',
                        message: `Captcha verification required after ${adCaptchaThreshold} ads`
                    }
                };
            }
            
            // التحقق من صحة الكابتشا
            const captchaResult = await verifyCaptchaToken(env, captchaToken);
            if (!captchaResult.valid) {
                // تحديث وقت آخر محاولة كابتشا
                await handleDbUpdate(env, `users/${userId}`, {
                    lastCaptchaTime: Date.now(),
                    lastUpdated: Date.now()
                });
                
                return {
                    success: false,
                    error: captchaResult.error,
                    errorCode: 'INVALID_CAPTCHA',
                    data: {
                        adsWatchedToday: adsWatchedToday,
                        errorDetails: captchaResult.errorDetails
                    }
                };
            }
            
            // إعادة تعيين عداد الإعلانات بعد التحقق الناجح للكابتشا
            adsWatchedToday = 1;
        }
        
        // إعداد التحديثات
        const updates = {
            [adCountField]: currentCount + 1,
            adsWatched: adsWatchedToday,
            dogsBalance: (userData.dogsBalance || 0) + expectedReward,
            lastAdDate: today,
            lastUpdated: Date.now(),
            lastActivity: Date.now()
        };
        
        // إذا تم التحقق من الكابتشا بنجاح، تسجيل الوقت
        if (adsWatchedToday === 1 && captchaToken) {
            updates.lastCaptchaVerified = Date.now();
        }
        
        await handleDbUpdate(env, `users/${userId}`, updates);
        
        await handleDbPush(env, `users/${userId}/history`, {
            type: 'earn',
            description: `${adType} Ad Reward`,
            amount: expectedReward,
            currency: 'GLX',
            date: new Date().toISOString(),
            captchaUsed: adsWatchedToday === 1,
            adsWatchedToday: adsWatchedToday
        });
        
        // جلب بيانات المستخدم المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || { ...userData, ...updates };
        
        return {
            success: true,
            data: {
                [adCountField]: currentCount + 1,
                adsWatched: updates.adsWatched,
                newBalance: updatedUserData.dogsBalance,
                reward: expectedReward,
                adsWatchedToday: adsWatchedToday,
                requiresCaptcha: adsWatchedToday >= 10,
                updatedUserData: updatedUserData
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'HANDLE_AD_CLICK_ERROR'
        };
    }
}

// ==================== دالة initializeUser المعدلة ====================

async function handleInitializeUser(env, userId, data, telegramData) {
    try {
        const { user, skipSubscriptionCheck } = data;
        const deviceFingerprint = data.deviceFingerprint;
        const fullName = `${user.first_name} ${user.last_name || ''}`.trim();
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return {
                success: false,
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: {
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // ==================== الاشتراك الإجباري معطّل ====================
        // جلب بيانات المستخدم (لا يزال مطلوباً لبقية الدالة)
        const userResult = await handleDbGet(env, `users/${userId}`);
        const existingUserData = userResult.data;
        
        
        // ==================== التحقق من بصمة الجهاز ====================
        if (deviceFingerprint) {
            // التحقق من صحة تنسيق البصمة
            const formatValidation = validateFingerprintFormat(deviceFingerprint);
            if (!formatValidation.valid) {
                return {
                    success: false,
                    error: formatValidation.error,
                    errorCode: 'INVALID_FINGERPRINT_FORMAT'
                };
            }
            
            // التحقق مما إذا كانت بصمة الجهاز مستخدمة بالفعل من قبل مستخدم آخر
            const fingerprintCheck = await checkDeviceFingerprintWithoutIP(env, deviceFingerprint, userId);
            
            if (fingerprintCheck.deviceAlreadyUsed) {
                // إذا كان المستخدم الحالي ليس الحساب الأول، يتم حظره
                if (fingerprintCheck.primaryAccount !== userId) {
                    // حظر الحساب الحالي فورًا
                    await applyBlock(env, userId, {
                        reason: 'Device multi-account violation during initialization',
                        violation: 'DEVICE_MULTI_ACCOUNT',
                        action: 'initializeUser',
                        details: 'Attempt to create new account with device registered to another account',
                        timestamp: Date.now(),
                        permanent: true,
                        deviceFingerprint: deviceFingerprint,
                        isNewAccount: true
                    });
                    
                    return {
                        success: false,
                        error: 'ACCOUNT_BLOCKED',
                        errorCode: 'DEVICE_MULTI_ACCOUNT_BLOCKED',
                        data: {
                            deviceAlreadyUsed: true,
                            existingAccounts: fingerprintCheck.existingAccounts,
                            primaryAccount: fingerprintCheck.primaryAccount,
                            isPrimaryAccount: false,
                            violationType: 'DEVICE_MULTI_ACCOUNT',
                            accountsBlocked: fingerprintCheck.newAccountsBlocked + 1,
                            currentAccountBlocked: true,
                            blockedMessage: `🚫 Account Blocked\n\nReason: Device multi-account violation\nViolation: DEVICE_MULTI_ACCOUNT\n\nThis decision is final.`,
                            redirectToBlockPage: true
                        }
                    };
                }
            }
        }
        // ==================== نهاية التحقق من بصمة الجهاز ====================
        
        // 1. أولاً: ضمان وجود مسابقة نشطة وجلب بياناتها
        const competitionData = await ensureAndGetCompetition(env, userId);
        
        if (!competitionData) {
            return {
                success: false,
                error: 'Failed to initialize competition',
                errorCode: 'COMPETITION_INIT_ERROR'
            };
        }
        
        // 2. جلب بيانات المستخدم
        const userResult2 = await handleDbGet(env, `users/${userId}`);
        let userData = userResult2.data;
        
        // احصل على عدد التذاكر الحقيقي من المسابقة
        const realTicketCount = competitionData.userTicketCount || 0;
        
        // استخراج صورة المستخدم من بيانات Telegram
        let photoUrl = 'https://i.ibb.co/tTkJX1Qy/logo.png'; // صورة افتراضية
        
        try {
            const params = new URLSearchParams(telegramData);
            const userParam = params.get('user');
            
            if (userParam) {
                const telegramUserData = JSON.parse(decodeURIComponent(userParam));
                // صورة المستخدم من Telegram
                if (telegramUserData.photo_url) {
                    photoUrl = telegramUserData.photo_url;
                } else if (telegramUserData.username) {
                    // أو استخدام صورة افتراضية بناءً على اسم المستخدم
                    photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(telegramUserData.username)}&background=random&color=fff`;
                }
            }
        } catch (photoError) {
            console.log('Could not extract user photo:', photoError);
        }
        
        if (!userData) {
            // إنشاء مستخدم جديد
            userData = {
                id: userId,
                name: fullName,
                photoUrl: photoUrl,
                dogsBalance: 500,
                tonBalance: 0.00,
                adsWatched: 0,
                adsMonetag: 0,
                adsGiga: 0,
                adsAdsgram: 0,
                completedTasks: {},
                history: {},
                referrals: 0,
                dailyStreak: 0,
                lastDailyClaim: 0,
                extraSpins: 1,
                referredUsers: [],
                usedPromoCodes: [],
                joinDate: Date.now(),
                lastLogin: Date.now(),
                lastAdDate: new Date().toDateString(),
                competitionTickets: realTicketCount,
                lastTicketSync: Date.now(),
                isBlocked: false,
                blockReason: null,
                blockedAt: null,
                violationCount: 0,
                lastUpdated: Date.now(),
                // بيانات الأمان
                ...(deviceFingerprint && {
                    deviceFingerprint: deviceFingerprint,
                    deviceRegisteredAt: Date.now(),
                    lastDeviceCheck: Date.now(),
                    deviceInfo: data.deviceInfo || {},
                    deviceLoginCount: 1
                }),
                // سجل الاشتراك الإجباري
                mandatoryChannelsSubscribed: true,
                subscriptionVerifiedAt: Date.now()
            };
            
            await handleDbSet(env, `users/${userId}`, userData);
            
            await handleDbPush(env, `users/${userId}/history`, {
                type: 'earn',
                description: 'Welcome Bonus',
                amount: 500,
                currency: 'GLX',
                date: new Date().toISOString(),
                securityCheck: 'initialized',
                mandatoryChannelsVerified: true
            });
            
            console.log(`New user created: ${userId} with device fingerprint: ${deviceFingerprint ? 'Yes' : 'No'}`);
        } else {
            // تحديث بيانات المستخدم الموجود
            const updates = {
                name: fullName,
                lastLogin: Date.now(),
                lastUpdated: Date.now()
            };
            
            // تحديث الصورة إذا كانت غير موجودة أو مختلفة
            if (!userData.photoUrl || userData.photoUrl === 'https://i.ibb.co/tTkJX1Qy/logo.png') {
                updates.photoUrl = photoUrl;
            }
            
            // تحديث عدد تذاكر المسابقة من المسابقة الحالية
            if (userData.competitionTickets !== realTicketCount) {
                updates.competitionTickets = realTicketCount;
                updates.lastTicketSync = Date.now();
                console.log(`Updating user ${userId} tickets from ${userData.competitionTickets} to ${realTicketCount}`);
            }
            
            // التحقق من الحظر في بيانات المستخدم
            if (userData.isBlocked) {
                const blockStatus = await checkUserBlocked(env, userId);
                if (blockStatus && blockStatus.isBlocked) {
                    return {
                        success: false,
                        error: 'ACCOUNT_BLOCKED',
                        errorCode: 'ACCOUNT_BLOCKED',
                        data: { 
                            isBlocked: true,
                            blockDetails: blockStatus,
                            blockedMessage: `🚫 Account Blocked\n\nReason: ${blockStatus.reason}\nViolation: ${blockStatus.violation}\n\nThis decision is final.`,
                            redirectToBlockPage: true
                        }
                    };
                } else {
                    updates.isBlocked = false;
                    updates.blockReason = null;
                    updates.blockedAt = null;
                }
            }
            
            // تحديث بصمة الجهاز إذا لم تكن موجودة وكانت متوفرة
            if (!userData.deviceFingerprint && deviceFingerprint) {
                updates.deviceFingerprint = deviceFingerprint;
                updates.deviceRegisteredAt = Date.now();
                updates.lastDeviceCheck = Date.now();
                updates.deviceInfo = data.deviceInfo || {};
                updates.deviceLoginCount = (userData.deviceLoginCount || 0) + 1;
            } else if (deviceFingerprint) {
                // تحديث آخر فحص للجهاز
                updates.lastDeviceCheck = Date.now();
                updates.deviceLoginCount = (userData.deviceLoginCount || 0) + 1;
            }
            
            // إعادة تعيين عداد الإعلانات إذا تغير اليوم
            const today = new Date().toDateString();
            if (userData.lastAdDate !== today) {
                updates.adsWatched = 0;
                updates.lastAdDate = today;
            }
            
            if (Object.keys(updates).length > 0) {
                await handleDbUpdate(env, `users/${userId}`, updates);
            }
            
            // تحديث بيانات المستخدم بعد التغييرات
            const updatedResult = await handleDbGet(env, `users/${userId}`);
            userData = updatedResult.data || userData;
            
            console.log(`Existing user logged in: ${userId} with device fingerprint: ${deviceFingerprint ? 'Yes' : 'No'}`);
        }
        
        // جلب الإعدادات
        const settingsResult = await handleGetConfig(env);
        const settings = settingsResult.data?.settings || {};
        
        // التأكد من أن عدد التذاكر يعكس القيمة الحقيقية
        const userTickets = realTicketCount;
        
        return {
            success: true,
            data: {
                userData: {
                    ...userData,
                    competitionTickets: userTickets,
                    deviceFingerprint: deviceFingerprint || userData.deviceFingerprint,
                    mandatoryChannelsSubscribed: userData.mandatoryChannelsSubscribed || true
                },
                settings: settings,
                contest: {
                    yourTickets: userTickets,
                    totalTickets: competitionData.totalTickets || 0,
                    prizePool: competitionData.prizePool || 0,
                    isActive: competitionData.isActiveNow,
                    endTime: competitionData.endTime,
                    startTime: competitionData.startTime,
                    timeRemaining: competitionData.timeRemaining,
                    timeRemainingFormatted: competitionData.timeRemainingFormatted || '24:00:00'
                },
                securityInfo: {
                    deviceVerified: !!deviceFingerprint,
                    mandatoryChannelsVerified: userData.mandatoryChannelsSubscribed || true,
                    multiAccountCheck: true
                },
                subscriptionInfo: {
                    required: true,
                    verified: userData.mandatoryChannelsSubscribed || true
                },
                captchaInfo: {
                    siteKey: '0x4AAAAAACOf6mYyukJx5XVy',
                    threshold: 10,
                    enabled: true
                }
            }
        };
    } catch (error) {
        console.error('Initialize user error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'INITIALIZE_USER_ERROR'
        };
    }
}

// ==================== دالة submitWithdrawal المعدلة مع النظام اليومي ====================

async function handleSubmitWithdrawal(env, userId, data) {
    try {
        const { method, account, amount, maskedAccount, memo } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // ✅ حد السحب اليومي معطّل - لا يوجد أي حظر، فقط بيانات إعلامية
        const limitCheck = await checkDailyWithdrawalLimit(env, userId);
        limitCheck.limitReached = false;
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        // جلب الإعدادات للحد الأدنى للسحب
        const configResult = await handleGetConfig(env);
        const settings = configResult.data?.settings || {};
        
        let minAmount = settings.minTonWithdrawal || 0.05;
        
        // التحقق من الحد الأدنى للسحب
        if (parseFloat(amount) < minAmount) {
            return { 
                success: false, 
                error: `Minimum withdrawal amount is ${minAmount} ${method === 'ton' ? 'TON' : 'USD'}`,
                errorCode: 'MINIMUM_WITHDRAWAL_AMOUNT',
                data: { 
                    minAmount: minAmount,
                    requestedAmount: amount,
                    method: method
                }
            };
        }
        
        // التحقق من الرصيد الكافي
        if ((userData.tonBalance || 0) < parseFloat(amount)) {
            return { 
                success: false, 
                error: 'Insufficient TON balance',
                errorCode: 'INSUFFICIENT_TON_BALANCE',
                data: {
                    currentBalance: userData.tonBalance || 0,
                    requiredAmount: parseFloat(amount),
                    difference: parseFloat(amount) - (userData.tonBalance || 0)
                }
            };
        }
        
        // خصم المبلغ من رصيد المستخدم
        const newBalance = (userData.tonBalance || 0) - parseFloat(amount);
        await handleDbUpdate(env, `users/${userId}`, { 
            tonBalance: newBalance,
            lastUpdated: Date.now(),
            lastWithdrawal: Date.now()
        });
        
        // إنشاء معرف فريد للسحب
        const withdrawalId = `withdrawal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const nowTs = Date.now();
        
        // إعداد بيانات السحب مع بيانات المستخدم الكاملة
        // ⚠️ ملاحظة توافق: بوت السحب التلقائي (index.js) بيقرأ من عقدة withdrawQueue
        // وبيحتاج الحقول address / ton / userId / wdId بالتحديد — فبنحطهم هنا
        // بالإضافة لأسماء الحقول القديمة (account/amount) عشان أي كود تاني في
        // السيرفر لسه بيعتمد عليها يفضل شغال زي ما هو.
        const withdrawalData = {
            userId: userId,
            wdId: withdrawalId,
            address: account,
            ton: parseFloat(amount),
            account: account,
            maskedAccount: maskedAccount || account,
            amount: parseFloat(amount),
            method: method,
            memo: memo || '',
            status: 'pending',
            timestamp: nowTs,
            ts: nowTs,
            updatedAt: nowTs,
            processed: false,
            // بيانات المستخدم الإضافية
            username: userData.username || userData.name || 'Unknown',
            first_name: userData.first_name || userData.name?.split(' ')[0] || 'Unknown',
            last_name: userData.last_name || userData.name?.split(' ').slice(1).join(' ') || '',
            userData: {
                name: userData.name || 'Unknown',
                photoUrl: userData.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png',
                joinDate: userData.joinDate,
                totalEarnings: userData.dogsBalance || 0,
                tonBalance: newBalance,
                referrals: userData.referrals || 0
            }
        };
        
        // حفظ السحب في withdrawQueue — العقدة اللي بوت السحب التلقائي بيراقبها فعليًا
        await handleDbSet(env, `withdrawQueue/${withdrawalId}`, withdrawalData);
        
        // مرجع مبدئي في سجل المستخدم — البوت بيحدّثه لـ "paid" بعد الدفع الفعلي
        await handleDbSet(env, `users/${userId}/wdHistory/${withdrawalId}`, {
            status: 'pending',
            amount: parseFloat(amount),
            address: account,
            method: method,
            createdAt: nowTs
        });
        
        // تسجيل العملية في سجل المستخدم
        await handleDbPush(env, `users/${userId}/history`, {
            type: 'withdraw',
            description: `${method === 'ton' ? 'TON Wallet' : 'FaucetPay'} Withdrawal`,
            amount: parseFloat(amount),
            currency: 'TON',
            date: new Date().toISOString(),
            withdrawalId: withdrawalId,
            status: 'pending',
            account: maskedAccount || account
        });
        
        // تحديث عداد السحوبات اليومية
        await handleDbUpdate(env, `users/${userId}`, {
            dailyWithdrawals: limitCheck.todayWithdrawals + 1,
            lastWithdrawalDate: Date.now(),
            lastUpdated: Date.now()
        });
        
        // جلب البيانات المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || userData;
        
        return {
            success: true,
            data: {
                newBalance: newBalance,
                withdrawalId: withdrawalId,
                withdrawalData: withdrawalData,
                updatedUserData: updatedUserData,
                dailyWithdrawals: limitCheck.todayWithdrawals + 1,
                dailyLimit: limitCheck.dailyLimit,
                remainingToday: Math.max(0, limitCheck.dailyLimit - (limitCheck.todayWithdrawals + 1)),
                message: 'Withdrawal request submitted successfully. It will be processed within 1-3 minutes.'
            }
        };
    } catch (error) {
        console.error('Submit withdrawal error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'SUBMIT_WITHDRAWAL_ERROR'
        };
    }
}

// ==================== دوال مساعدة ====================

// التحقق من بيانات Telegram
function isValidTelegramData(telegramData, userId) {
    try {
        const params = new URLSearchParams(telegramData);
        const userParam = params.get('user');
        
        if (!userParam) return false;
        
        const userData = JSON.parse(decodeURIComponent(userParam));
        return userData.id.toString() === userId;
        
    } catch (error) {
        console.error('Telegram data validation error:', error);
        return false;
    }
}

// دالة مساعدة لتحويل أول حرف إلى كبير
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

// التحقق من حظر المستخدم
async function checkUserBlocked(env, userId) {
    try {
        const blockResult = await handleDbGet(env, `blocks/${userId}`);
        if (blockResult.success && blockResult.data) {
            const blockData = blockResult.data;
            
            // التحقق من انتهاء مدة الحظر
            if (blockData.expiresAt && blockData.expiresAt > Date.now()) {
                return {
                    isBlocked: true,
                    reason: blockData.reason || 'Account blocked',
                    violation: blockData.violation || 'UNKNOWN',
                    appliedAt: blockData.appliedAt,
                    expiresAt: blockData.expiresAt,
                    permanent: blockData.permanent || false,
                    details: blockData.details || 'No details provided',
                    blockType: 'TEMPORARY_BLOCK'
                };
            } else if (blockData.permanent) {
                return {
                    isBlocked: true,
                    reason: blockData.reason || 'Permanently blocked',
                    violation: blockData.violation || 'UNKNOWN',
                    appliedAt: blockData.appliedAt,
                    permanent: true,
                    details: blockData.details || 'Account permanently blocked',
                    blockType: 'PERMANENT_BLOCK'
                };
            }
            
            // إذا انتهت مدة الحظر المؤقت، إزالته
            if (blockData.expiresAt && blockData.expiresAt <= Date.now()) {
                await handleDbSet(env, `blocks/${userId}`, null);
                await handleDbUpdate(env, `users/${userId}`, {
                    isBlocked: false,
                    blockReason: null,
                    blockedAt: null
                });
                return false;
            }
        }
        
        return false;
    } catch (error) {
        console.error('Error checking user block:', error);
        return false;
    }
}

// تطبيق الحظر
async function applyBlock(env, userId, blockData) {
    try {
        const blockInfo = {
            userId: userId,
            reason: blockData.reason || 'System violation detected',
            violation: blockData.violation || 'UNKNOWN',
            appliedAt: Date.now(),
            expiresAt: null, // حظر دائم بعد مخالفة واحدة
            permanent: true, // حظر دائم
            blockData: blockData,
            action: blockData.action || 'UNKNOWN',
            details: blockData.details || 'No details',
            deviceFingerprint: blockData.deviceFingerprint || 'Unknown',
            isNewAccount: blockData.isNewAccount || false
        };
        
        // حفظ معلومات الحظر
        await handleDbSet(env, `blocks/${userId}`, blockInfo);
        
        // تحديث حالة المستخدم
        await handleDbUpdate(env, `users/${userId}`, {
            isBlocked: true,
            blockReason: blockInfo.reason,
            blockedAt: Date.now(),
            violationCount: 1,
            lastViolation: Date.now(),
            lastUpdated: Date.now()
        });
        
        // تسجيل الحظر في سجل الحظر العام
        await handleDbPush(env, 'system/blocks', {
            userId: userId,
            reason: blockInfo.reason,
            violation: blockInfo.violation,
            appliedAt: Date.now(),
            permanent: true,
            action: blockData.action,
            details: blockData.details,
            deviceFingerprint: blockData.deviceFingerprint,
            isNewAccount: blockData.isNewAccount || false
        });
        
        console.log(`User ${userId} permanently blocked: ${blockInfo.reason}, New Account: ${blockData.isNewAccount || false}`);
        
        return true;
    } catch (error) {
        console.error('Error applying block:', error);
        return false;
    }
}

// تسجيل مخالفة
async function recordViolation(env, userId, violationData) {
    try {
        // تسجيل المخالفة
        await handleDbPush(env, `violations/${userId}`, violationData);
        
        // زيادة عداد المخالفات
        const violationsResult = await handleDbGet(env, `violationCounts/${userId}`);
        const currentCount = violationsResult.data?.count || 0;
        const newCount = currentCount + 1;
        
        await handleDbSet(env, `violationCounts/${userId}`, {
            count: newCount,
            lastViolation: Date.now(),
            userId: userId,
            violationDetails: violationData
        });
        
        console.log(`Violation recorded for user ${userId}: ${violationData.violation}`);
        
        return true;
    } catch (error) {
        console.error('Error recording violation:', error);
        return false;
    }
}

// دالة مساعدة لإنشاء رابط Firebase
async function getFirebaseUrl(env, path) {
    const baseUrl = env.FIREBASE_DATABASE_URL.replace(/\/$/, '');
    const cleanPath = path.replace(/^\//, '');
    const apiKey = env.FIREBASE_API_KEY;
    
    if (!apiKey) {
        throw new Error('FIREBASE_API_KEY is not configured');
    }
    
    return `${baseUrl}/${cleanPath}.json?key=${apiKey}`;
}

// دالة مساعدة لضمان وجود مسابقة نشطة وجلب بياناتها
async function ensureAndGetCompetition(env, userId = null) {
    try {
        // جلب المسابقة الحالية
        const competitionResult = await handleDbGet(env, 'competition/current');
        let competitionData = competitionResult.data || {};
        
        const now = Date.now();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        
        // التحقق مما إذا كان يجب إنشاء مسابقة جديدة
        const shouldCreateNew = 
            !competitionData ||
            Object.keys(competitionData).length === 0 ||
            !competitionData.isActive || 
            !competitionData.endTime || 
            now > competitionData.endTime;
        
        if (shouldCreateNew) {
            console.log('Creating new competition... Current time:', now);
            
            // إذا كانت هناك مسابقة قديمة، حفظ الفائزين
            if (competitionData && competitionData.userTickets && Object.keys(competitionData.userTickets).length > 0) {
                await saveCompetitionWinners(env, competitionData);
            }
            
            // إنشاء مسابقة جديدة
            competitionData = {
                isActive: true,
                startTime: now,
                endTime: now + ONE_DAY_MS, // 24 ساعة من الآن
                totalTickets: 0,
                prizePool: 0,
                userTickets: {},
                winners: [],
                lastUpdated: now
            };
            
            // حفظ المسابقة الجديدة
            await handleDbSet(env, 'competition/current', competitionData);
            console.log('New competition created. End time:', new Date(competitionData.endTime).toISOString());
        } else {
            console.log('Existing competition found. End time:', new Date(competitionData.endTime).toISOString());
        }
        
        // حساب الوقت المتبقي
        competitionData.timeRemaining = Math.max(0, competitionData.endTime - now);
        competitionData.isActiveNow = competitionData.isActive && competitionData.timeRemaining > 0;
        
        // إذا انتهت المسابقة، إنشاء مسابقة جديدة
        if (competitionData.timeRemaining <= 0 && competitionData.isActive) {
            console.log('Competition ended, creating new one...');
            competitionData.isActive = false;
            await handleDbSet(env, 'competition/current', competitionData);
            return await ensureAndGetCompetition(env, userId);
        }
        
        // إذا تم تمرير userId، حساب تذاكره بشكل صحيح
        if (userId) {
            competitionData.userTickets = competitionData.userTickets || {};
            competitionData.userTicketCount = competitionData.userTickets[userId] || 0;
            console.log(`User ${userId} tickets in competition:`, competitionData.userTicketCount);
            
            // تحديث تذاكر المستخدم في قاعدة البيانات
            await syncUserCompetitionTickets(env, userId, competitionData.userTicketCount);
        }
        
        // إضافة التنسيق الزمني للوقت المتبقي
        competitionData.timeRemainingFormatted = formatTimeRemaining(competitionData.timeRemaining);
        
        return competitionData;
    } catch (error) {
        console.error('Error ensuring competition:', error);
        return null;
    }
}

// دالة لتنسيق الوقت المتبقي
function formatTimeRemaining(ms) {
    if (ms <= 0) return '00:00:00';
    
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((ms % (1000 * 60)) / 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// دالة لحفظ الفائزين في المسابقة القديمة
async function saveCompetitionWinners(env, competitionData) {
    try {
        if (!competitionData.userTickets || Object.keys(competitionData.userTickets).length === 0) {
            return;
        }
        
        const userIds = Object.keys(competitionData.userTickets);
        const totalTickets = competitionData.totalTickets || 0;
        
        if (totalTickets > 0) {
            // اختيار الفائز (الذي لديه أكبر عدد تذاكر)
            let winnerId = userIds[0];
            let maxTickets = competitionData.userTickets[winnerId] || 0;
            
            for (const userId of userIds) {
                const tickets = competitionData.userTickets[userId] || 0;
                if (tickets > maxTickets) {
                    maxTickets = tickets;
                    winnerId = userId;
                }
            }
            
            // حفظ بيانات الفائز
            const winnerData = {
                userId: winnerId,
                tickets: maxTickets,
                prize: competitionData.prizePool || 0,
                timestamp: Date.now(),
                competitionEndTime: competitionData.endTime
            };
            
            await handleDbPush(env, 'competition/winners', winnerData);
            
            // منح الجائزة للمستخدم الفائز
            const userResult = await handleDbGet(env, `users/${winnerId}`);
            if (userResult.success && userResult.data) {
                const userData = userResult.data;
                const newBalance = (userData.tonBalance || 0) + (competitionData.prizePool || 0);
                await handleDbUpdate(env, `users/${winnerId}`, { 
                    tonBalance: newBalance 
                });
                
                await handleDbPush(env, `users/${winnerId}/history`, {
                    type: 'earn',
                    description: 'Competition Prize',
                    amount: competitionData.prizePool || 0,
                    currency: 'TON',
                    date: new Date().toISOString()
                });
                
                console.log(`Prize awarded to user ${winnerId}: ${competitionData.prizePool} TON`);
            }
        }
    } catch (error) {
        console.error('Error saving competition winners:', error);
    }
}

// دالة لتحديث تذاكر المسابقة للمستخدم في قاعدة البيانات
async function syncUserCompetitionTickets(env, userId, ticketCount) {
    try {
        // جلب بيانات المستخدم أولاً
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            console.log(`User ${userId} not found for ticket sync`);
            return false;
        }
        
        const userData = userResult.data;
        const currentTickets = userData.competitionTickets || 0;
        
        // تحديث فقط إذا كانت القيمة مختلفة
        if (currentTickets !== ticketCount) {
            console.log(`Syncing tickets for user ${userId}: ${currentTickets} -> ${ticketCount}`);
            await handleDbUpdate(env, `users/${userId}`, {
                competitionTickets: ticketCount,
                lastTicketSync: Date.now(),
                lastUpdated: Date.now()
            });
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Error syncing user competition tickets:', error);
        return false;
    }
}

// ==================== وظائف إدارة قاعدة البيانات ====================

async function handleDbSet(env, path, data) {
    try {
        const firebaseUrl = await getFirebaseUrl(env, path);
        
        const response = await fetch(firebaseUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Firebase error: ${response.status} - ${errorText}`);
        }
        
        const result = await response.json();
        
        return {
            success: true,
            data: result
        };
    } catch (error) {
        console.error('Database SET error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'DB_SET_ERROR'
        };
    }
}

async function handleDbGet(env, path) {
    try {
        const firebaseUrl = await getFirebaseUrl(env, path);
        
        const response = await fetch(firebaseUrl);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Firebase error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        return {
            success: true,
            data: data
        };
    } catch (error) {
        console.error('Database GET error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'DB_GET_ERROR'
        };
    }
}

async function handleDbUpdate(env, path, updates) {
    try {
        const firebaseUrl = await getFirebaseUrl(env, path);
        
        const response = await fetch(firebaseUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Firebase error: ${response.status} - ${errorText}`);
        }
        
        const result = await response.json();
        
        return {
            success: true,
            data: result
        };
    } catch (error) {
        console.error('Database UPDATE error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'DB_UPDATE_ERROR'
        };
    }
}

async function handleDbPush(env, path, data) {
    try {
        const firebaseUrl = await getFirebaseUrl(env, path);
        
        const response = await fetch(firebaseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Firebase error: ${response.status} - ${errorText}`);
        }
        
        const result = await response.json();
        
        return {
            success: true,
            data: { name: result.name }
        };
    } catch (error) {
        console.error('Database PUSH error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'DB_PUSH_ERROR'
        };
    }
}

async function handleDbTransaction(env, path, transactionFunction) {
    try {
        const currentData = await handleDbGet(env, path);
        
        if (!currentData.success) {
            return currentData;
        }
        
        const func = new Function('currentValue', `return ${transactionFunction}(currentValue)`);
        const newValue = func(currentData.data || null);
        
        const updateResult = await handleDbSet(env, path, newValue);
        
        return updateResult;
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'DB_TRANSACTION_ERROR'
        };
    }
}

async function handleDbIncrement(env, path, key, amount) {
    try {
        const currentData = await handleDbGet(env, path);
        
        if (!currentData.success) {
            return currentData;
        }
        
        const currentValue = currentData.data[key] || 0;
        const newValue = currentValue + amount;
        
        const updates = { [key]: newValue };
        const updateResult = await handleDbUpdate(env, path, updates);
        
        return updateResult;
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'DB_INCREMENT_ERROR'
        };
    }
}

// ==================== باقي الوظائف كما هي مع تعديلات بسيطة ====================

// وظيفة للحصول على IP العميل (متبقية للتوافق فقط)
async function handleGetClientIP(clientIp) {
    return {
        success: true,
        data: {
            clientIp: clientIp,
            timestamp: Date.now()
        }
    };
}

// التحقق من استخدام نفس الطابع الزمني مسبقًا
async function checkDuplicateTimestamp(env, userId, timestamp) {
    try {
        const timestampsResult = await handleDbGet(env, `users/${userId}/requestTimestamps`);
        const timestamps = timestampsResult.data || {};
        
        // البحث عن طابع زمني مطابق
        for (const [key, tsData] of Object.entries(timestamps)) {
            if (tsData.timestamp === timestamp) {
                return true;
            }
        }
        
        // حفظ الطابع الزمني الجديد
        await handleDbPush(env, `users/${userId}/requestTimestamps`, {
            timestamp: timestamp,
            recordedAt: Date.now()
        });
        
        // تنظيف الطوابع الزمنية القديمة (أقدم من 5 دقائق)
        const cleanTimestamps = {};
        const fiveMinutesAgo = Date.now() - 300000;
        
        for (const [key, tsData] of Object.entries(timestamps)) {
            if (tsData.recordedAt > fiveMinutesAgo) {
                cleanTimestamps[key] = tsData;
            }
        }
        
        await handleDbSet(env, `users/${userId}/requestTimestamps`, cleanTimestamps);
        
        return false;
    } catch (error) {
        console.error('Error checking duplicate timestamp:', error);
        return false;
    }
}

// التحقق من صحة طلب البرومو كود
async function validatePromoCodeRequest(env, userId, data) {
    const { code } = data;
    
    // جلب البرومو كود من قاعدة البيانات
    const promoCodesResult = await handleDbGet(env, 'promocodes');
    const promoCodes = promoCodesResult.data || {};
    
    let promoCodeData = null;
    let promoCodeKey = null;
    
    // البحث عن البرومو كود
    for (const [key, promo] of Object.entries(promoCodes)) {
        if (promo.code === code) {
            promoCodeData = promo;
            promoCodeKey = key;
            break;
        }
    }
    
    // إذا لم يتم العثور على البرومو كود
    if (!promoCodeData) {
        return {
            valid: false,
            violation: 'INVALID_PROMO_CODE',
            details: `Promo code not found: ${code}`,
            shouldBlock: false  // خطأ فقط بدون حظر
        };
    }
    
    // التحقق من حالة البرومو كود
    if (promoCodeData.status !== 'active') {
        return {
            valid: false,
            violation: 'INACTIVE_PROMO_CODE',
            details: `Promo code is not active: ${code}`,
            shouldBlock: false  // خطأ فقط بدون حظر
        };
    }
    
    // التحقق من الحد الأقصى للاستخدام
    if (promoCodeData.usedCount >= promoCodeData.maxUsage) {
        return {
            valid: false,
            violation: 'PROMO_CODE_LIMIT_EXCEEDED',
            details: `Promo code usage limit reached: ${code}`,
            shouldBlock: false  // خطأ فقط بدون حظر
        };
    }
    
    // جلب بيانات المستخدم للتحقق من الاستخدام السابق
    const userResult = await handleDbGet(env, `users/${userId}`);
    if (userResult.success && userResult.data) {
        const userData = userResult.data;
        const usedPromoCodes = userData.usedPromoCodes || [];
        
        // التحقق مما إذا كان المستخدم قد استخدم هذا البرومو كود من قبل
        for (const usedCode of usedPromoCodes) {
            if (usedCode.code === code || usedCode === code) {
                // التحقق من عدد مرات الاستخدام المسموح بها للمستخدم
                if (usedCode.usageCount >= (promoCodeData.usagePerUser || 1)) {
                    return {
                        valid: false,
                        violation: 'PROMO_CODE_ALREADY_USED',
                        details: `User has already used this promo code maximum times: ${code}`,
                        shouldBlock: false  // خطأ فقط بدون حظر
                    };
                }
                break;
            }
        }
    }
    
    // التحقق من قيمة المكافأة بناءً على النوع
    const rewardAmount = promoCodeData.rewardAmount || 0;
    const rewardType = promoCodeData.rewardType || 'glx';
    
    // التحقق من الحد الأقصى للمكافأة بناءً على النوع
    const configResult = await handleGetConfig(env);
    const settings = configResult.data?.settings || {};
    
    if (rewardType === 'glx') {
        const MAX_GLX_REWARD = 100000; // 100,000 GLX كحد أقصى
        if (rewardAmount > MAX_GLX_REWARD) {
            return {
                valid: false,
                violation: 'EXCESSIVE_PROMO_REWARD',
                details: `GLX reward too high: ${rewardAmount} (max ${MAX_GLX_REWARD})`
            };
        }
    } else if (rewardType === 'ton') {
        const MAX_TON_REWARD = 1; // 1 TON كحد أقصى
        if (rewardAmount > MAX_TON_REWARD) {
            return {
                valid: false,
                violation: 'EXCESSIVE_PROMO_REWARD',
                details: `TON reward too high: ${rewardAmount} (max ${MAX_TON_REWARD})`
            };
        }
    } else if (rewardType === 'tickets') {
        const MAX_TICKETS_REWARD = 100; // 100 تذكرة كحد أقصى
        if (rewardAmount > MAX_TICKETS_REWARD) {
            return {
                valid: false,
                violation: 'EXCESSIVE_PROMO_REWARD',
                details: `Tickets reward too high: ${rewardAmount} (max ${MAX_TICKETS_REWARD})`
            };
        }
    }
    
    return { valid: true };
}

// التحقق من صحة طلب المهمة
async function validateTaskRequest(env, userId, data) {
    const { taskId, reward, title } = data;
    
    // الحد الأقصى لمكافأة المهمة
    const MAX_TASK_REWARD = 10000;
    
    if (parseInt(reward) > MAX_TASK_REWARD) {
        return {
            valid: false,
            violation: 'EXCESSIVE_TASK_REWARD',
            details: `Task reward too high: ${reward}`
        };
    }
    
    // تم إزالة التحقق من إكمال المهمة مسبقًا للسماح بإكمال المهمة عدة مرات
    // التحقق فقط من أن المكافأة لا تتجاوز الحد الأقصى
    
    return { valid: true };
}

// التحقق من صحة شراء التذاكر
async function validateTicketPurchase(env, userId, data) {
    const { tickets, totalCost } = data;
    
    // سعر التذكرة الواحدة
    const TICKET_PRICE = 10000; // سعر التذكرة = 10,000 GLX
    
    // الحد الأقصى للتذاكر في كل عملية
    const MAX_TICKETS_PER_PURCHASE = 100;
    
    // الحد الأدنى للتذاكر
    const MIN_TICKETS_PER_PURCHASE = 1;
    
    const ticketsCount = parseInt(tickets);
    const costAmount = parseInt(totalCost);
    
    // التحقق من عدد التذاكر
    if (ticketsCount < MIN_TICKETS_PER_PURCHASE) {
        return {
            valid: false,
            violation: 'INSUFFICIENT_TICKETS',
            details: `Too few tickets: ${ticketsCount}`
        };
    }
    
    if (ticketsCount > MAX_TICKETS_PER_PURCHASE) {
        return {
            valid: false,
            violation: 'EXCESSIVE_TICKET_PURCHASE',
            details: `Too many tickets: ${ticketsCount} (max ${MAX_TICKETS_PER_PURCHASE})`
        };
    }
    
    // التحقق من أن التكلفة متناسبة مع عدد التذاكر
    const expectedCost = ticketsCount * TICKET_PRICE;
    
    if (costAmount !== expectedCost) {
        return {
            valid: false,
            violation: 'COST_MANIPULATION',
            details: `Ticket cost manipulation: Expected ${expectedCost}, got ${costAmount}`
        };
    }
    
    return { valid: true };
}

// التحقق من صحة لعبة قلب العملة
async function validateCoinFlip(env, userId, data) {
    const { betAmount } = data;
    
    // الحد الأقصى للرهان
    const MAX_BET_AMOUNT = 100000; // 100,000 GLX كحد أقصى
    
    // الحد الأدنى للرهان
    const MIN_BET_AMOUNT = 1000; // 1,000 GLX كحد أدنى
    
    const betAmountNum = parseInt(betAmount);
    
    if (betAmountNum > MAX_BET_AMOUNT) {
        return {
            valid: false,
            violation: 'EXCESSIVE_BET_AMOUNT',
            details: `Bet amount too high: ${betAmountNum} (max ${MAX_BET_AMOUNT})`,
            shouldBlock: false  // خطأ فقط بدون حظر
        };
    }
    
    if (betAmountNum < MIN_BET_AMOUNT) {
        return {
            valid: false,
            violation: 'INSUFFICIENT_BET_AMOUNT',
            details: `Bet amount too low: ${betAmountNum} (min ${MIN_BET_AMOUNT})`
        };
    }
    
    return { valid: true };
}

// التحقق من صحة مكافأة المهمة
async function validateTaskReward(env, userId, data, action) {
    let reward;
    let taskId;
    
    if (action === 'verifyTaskCompletion') {
        reward = data.reward;
        taskId = data.taskId;
    } else if (action === 'verifyTaskChannel') {
        reward = 2000; // مكافأة ثابتة للانضمام للقناة
    } else {
        return { valid: true };
    }
    
    // جلب بيانات المهمة للتحقق
    if (taskId) {
        const taskResult = await handleDbGet(env, `tasks/${taskId}`);
        if (taskResult.success && taskResult.data) {
            const task = taskResult.data;
            const taskReward = task.reward || 0;
            
            // إذا كانت المهمة لها مكافأة محددة، التحقق منها
            if (taskReward > 0 && parseInt(reward) !== taskReward) {
                return {
                    valid: false,
                    violation: 'TASK_REWARD_MANIPULATION',
                    details: `Task reward manipulation: Expected ${taskReward}, got ${reward}`
                };
            }
        }
    }
    
    // الحد الأقصى لمكافأة المهمة
    const MAX_TASK_REWARD = 20000;
    
    if (parseInt(reward) > MAX_TASK_REWARD) {
        return {
            valid: false,
            violation: 'EXCESSIVE_TASK_REWARD',
            details: `Task reward too high: ${reward}`
        };
    }
    
    return { valid: true };
}

// التحقق من صحة لعبة السلوتس
async function validateSlotSpin(env, userId) {
    // التحقق من وجود محاولات دوران كافية
    const userResult = await handleDbGet(env, `users/${userId}`);
    if (userResult.success && userResult.data) {
        const userData = userResult.data;
        
        if ((userData.extraSpins || 0) <= 0) {
            return {
                valid: false,
                violation: 'NO_SPINS_AVAILABLE',
                details: 'No spins available'
            };
        }
    }
    
    return { valid: true };
}

// التحقق من صحة المكافأة اليومية
async function validateDailyBonus(env, userId) {
    const userResult = await handleDbGet(env, `users/${userId}`);
    if (userResult.success && userResult.data) {
        const userData = userResult.data;
        const now = Date.now();
        const lastClaim = userData.lastDailyClaim || 0;
        const msInDay = 86400000;
        
        // التحقق من أنه لم يحصل على المكافأة اليوم
        if (now - lastClaim < msInDay) {
            return {
                valid: false,
                violation: 'DAILY_BONUS_ALREADY_CLAIMED',
                details: 'Daily bonus already claimed today',
                shouldBlock: false // رفض فقط بدون حظر
            };
        }
    }
    
    return { valid: true };
}

// التحقق من صحة طلب السحب
async function validateWithdrawalRequest(env, userId, data) {
    const { amount, method } = data;
    
    // ✅ FaucetPay معطّل - السحب متاح فقط عبر TON Wallet
    if (method !== 'ton') {
        return {
            valid: false,
            violation: 'WITHDRAWAL_METHOD_DISABLED',
            details: 'Only TON Wallet withdrawals are supported'
        };
    }
    
    const userResult = await handleDbGet(env, `users/${userId}`);
    if (userResult.success && userResult.data) {
        const userData = userResult.data;
        
        // التحقق من الحد الأدنى للسحب
        const configResult = await handleGetConfig(env);
        const settings = configResult.data?.settings || {};
        
        const minAmount = settings.minTonWithdrawal || 0.05;
        
        if (parseFloat(amount) < minAmount) {
            return {
                valid: false,
                violation: 'INSUFFICIENT_WITHDRAWAL_AMOUNT',
                details: `Withdrawal amount too low: ${amount} (min ${minAmount})`
            };
        }
        
        // التحقق من الرصيد الكافي
        if ((userData.tonBalance || 0) < parseFloat(amount)) {
            return {
                valid: false,
                violation: 'INSUFFICIENT_BALANCE_FOR_WITHDRAWAL',
                details: 'Insufficient TON balance for withdrawal'
            };
        }
    }
    
    return { valid: true };
}

// التحقق من صحة طلب التحويل
async function validateSwapRequest(env, userId, data) {
    const { type, amount, tonValue, glxValue } = data;
    
    const userResult = await handleDbGet(env, `users/${userId}`);
    if (userResult.success && userResult.data) {
        const userData = userResult.data;
        
        if (type === 'glx_to_ton') {
            if (userData.dogsBalance < amount) {
                return {
                    valid: false,
                    violation: 'INSUFFICIENT_GLX_FOR_SWAP',
                    details: 'Insufficient GLX balance for swap',
                    shouldBlock: false  // خطأ فقط بدون حظر
                };
            }
        } else if (type === 'ton_to_glx') {
            if ((userData.tonBalance || 0) < amount) {
                return {
                    valid: false,
                    violation: 'INSUFFICIENT_TON_FOR_SWAP',
                    details: 'Insufficient TON balance for swap',
                    shouldBlock: false  // خطأ فقط بدون حظر
                };
            }
        }
    }
    
    return { valid: true };
}

// التحقق من صحة طلب الإيداع (تم إزالة التحقق من memo)
async function validateDepositRequest(env, userId, data) {
    const { memo, amount } = data;
    
    // تم إزالة التحقق من صحة تنسيق memo بناءً على طلبك
    
    // التحقق من أن المبلغ إيجابي (يبقى كما هو)
    if (parseFloat(amount) <= 0) {
        return {
            valid: false,
            violation: 'INVALID_DEPOSIT_AMOUNT',
            details: 'Deposit amount must be positive',
            shouldBlock: false  // خطأ فقط بدون حظر
        };
    }
    
    return { valid: true };
}

// ==================== باقي الوظائف الكاملة ====================

async function handleExecuteSwap(env, userId, data) {
    try {
        const { type, amount } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        // ✅ إصلاح أمان: كنا بنثق في tonValue/glxValue الجايين من الفرونت اند
        // مباشرة، وده كان بيسمح لأي حد يبعت قيمة اختيارية ويزود رصيده بأي رقم.
        // دلوقتي السعر بيتحسب هنا من إعدادات الفاير باس (settings.tskToTonRate /
        // tonToTskRate) وبس - مفيش أي قيمة من العميل بتتصدق.
        const settings = await getOrInitAppSettings(env);
        const tskToTonRate = settings.tskToTonRate || 0.0000001;
        const tonToTskRate = settings.tonToTskRate || 10000000;
        
        const userData = userResult.data;
        let updates = {};
        let historyEntry = {};
        
        if (type === 'glx_to_ton') {
            if (userData.dogsBalance < amount) {
                return { 
                    success: false, 
                    error: 'Insufficient GLX balance',
                    errorCode: 'INSUFFICIENT_GLX_BALANCE'
                };
            }
            
            const tonValue = amount * tskToTonRate;
            
            updates.dogsBalance = userData.dogsBalance - amount;
            updates.tonBalance = (userData.tonBalance || 0) + tonValue;
            updates.lastUpdated = Date.now();
            
            historyEntry = {
                type: 'swap_out',
                description: 'Swap GLX to TON',
                amount: amount,
                currency: 'GLX',
                date: new Date().toISOString()
            };
            
            await handleDbPush(env, `users/${userId}/history`, historyEntry);
            
            historyEntry = {
                type: 'swap_in',
                description: 'Received from GLX Swap',
                amount: tonValue,
                currency: 'TON',
                date: new Date().toISOString()
            };
            
        } else if (type === 'ton_to_glx') {
            if ((userData.tonBalance || 0) < amount) {
                return { 
                    success: false, 
                    error: 'Insufficient TON balance',
                    errorCode: 'INSUFFICIENT_TON_BALANCE'
                };
            }
            
            const glxValue = amount * tonToTskRate;
            
            updates.tonBalance = (userData.tonBalance || 0) - amount;
            updates.dogsBalance = (userData.dogsBalance || 0) + glxValue;
            updates.lastUpdated = Date.now();
            
            historyEntry = {
                type: 'swap_out',
                description: 'Swap TON to GLX',
                amount: amount,
                currency: 'TON',
                date: new Date().toISOString()
            };
            
            await handleDbPush(env, `users/${userId}/history`, historyEntry);
            
            historyEntry = {
                type: 'swap_in',
                description: 'Received from TON Swap',
                amount: glxValue,
                currency: 'GLX',
                date: new Date().toISOString()
            };
        } else {
            return { 
                success: false, 
                error: 'Invalid swap type',
                errorCode: 'INVALID_SWAP_TYPE'
            };
        }
        
        await handleDbUpdate(env, `users/${userId}`, updates);
        
        await handleDbPush(env, `users/${userId}/history`, historyEntry);
        
        // جلب بيانات المستخدم المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || { ...userData, ...updates };
        
        return {
            success: true,
            data: {
                newGLXBalance: updatedUserData.dogsBalance,
                newTONBalance: updatedUserData.tonBalance,
                updatedUserData: updatedUserData
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'EXECUTE_SWAP_ERROR'
        };
    }
}

async function handleVerifyDeposit(env, userId, data) {
    try {
        const { memo, amount } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const currentTime = Date.now();
        const memoTime = parseInt(memo.split('_').pop());
        
        if (currentTime - memoTime > 30000) {
            const userResult = await handleDbGet(env, `users/${userId}`);
            if (!userResult.success) {
                return { 
                    success: false, 
                    error: 'User not found',
                    errorCode: 'USER_NOT_FOUND'
                };
            }
            
            const userData = userResult.data;
            const newBalance = (userData.tonBalance || 0) + amount;
            
            await handleDbUpdate(env, `users/${userId}`, { 
                tonBalance: newBalance,
                lastUpdated: Date.now()
            });
            
            await handleDbPush(env, `users/${userId}/history`, {
                type: 'deposit',
                description: `TON Deposit #${memo.substring(0, 8)}`,
                amount: amount,
                currency: 'TON',
                date: new Date().toISOString()
            });
            
            // جلب البيانات المحدثة
            const updatedUserResult = await handleDbGet(env, `users/${userId}`);
            const updatedUserData = updatedUserResult.data || { ...userData, tonBalance: newBalance };
            
            return {
                success: true,
                data: {
                    newBalance: newBalance,
                    txHash: memo.substring(0, 12),
                    updatedUserData: updatedUserData
                }
            };
        } else {
            return { 
                success: false, 
                error: 'Deposit not confirmed yet',
                errorCode: 'DEPOSIT_NOT_CONFIRMED'
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'VERIFY_DEPOSIT_ERROR'
        };
    }
}

async function handleBuyTickets(env, userId, data) {
    try {
        const { tickets, totalCost } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        // جلب سعر التذكرة من الإعدادات
        const configResult = await handleGetConfig(env);
        const settings = configResult.data?.settings || {};
        const TICKET_PRICE = settings.ticketPrice || 10000;
        
        // حساب التكلفة المتوقعة
        const ticketsCount = parseInt(tickets);
        const expectedCost = ticketsCount * TICKET_PRICE;
        const costAmount = parseInt(totalCost);
        
        // التحقق من صحة التكلفة
        if (costAmount !== expectedCost) {
            return { 
                success: false, 
                error: `Invalid ticket cost: Expected ${expectedCost}, got ${costAmount}`,
                errorCode: 'INVALID_TICKET_COST'
            };
        }
        
        if (userData.dogsBalance < costAmount) {
            return { 
                success: false, 
                error: 'Insufficient GLX balance',
                errorCode: 'INSUFFICIENT_GLX_BALANCE'
            };
        }
        
        const newBalance = userData.dogsBalance - costAmount;
        
        // تحديث رصيد المستخدم أولاً
        await handleDbUpdate(env, `users/${userId}`, { 
            dogsBalance: newBalance,
            lastUpdated: Date.now()
        });
        
        // تأكد من وجود مسابقة نشطة
        const competitionData = await ensureAndGetCompetition(env, userId);
        
        if (!competitionData) {
            return { 
                success: false, 
                error: 'No active competition found',
                errorCode: 'NO_ACTIVE_COMPETITION'
            };
        }
        
        // تحديث تذاكر المستخدم في المسابقة
        const currentUserTickets = competitionData.userTickets[userId] || 0;
        competitionData.userTickets[userId] = currentUserTickets + ticketsCount;
        
        // تحديث الإحصائيات العامة
        competitionData.totalTickets = (competitionData.totalTickets || 0) + ticketsCount;
        competitionData.prizePool = competitionData.totalTickets * 0.001;
        
        // حفظ المسابقة المحدثة
        await handleDbSet(env, 'competition/current', {
            isActive: competitionData.isActive,
            startTime: competitionData.startTime,
            endTime: competitionData.endTime,
            totalTickets: competitionData.totalTickets,
            prizePool: competitionData.prizePool,
            userTickets: competitionData.userTickets,
            winners: competitionData.winners || [],
            lastUpdated: Date.now()
        });
        
        // تحديث عدد تذاكر المستخدم في بياناته الشخصية
        const newTicketCount = competitionData.userTickets[userId];
        await handleDbUpdate(env, `users/${userId}`, {
            competitionTickets: newTicketCount,
            lastTicketSync: Date.now(),
            lastUpdated: Date.now()
        });
        
        await handleDbPush(env, `users/${userId}/history`, {
            type: 'spend',
            description: `Bought ${ticketsCount} Competition Ticket${ticketsCount > 1 ? 's' : ''}`,
            amount: costAmount,
            currency: 'GLX',
            date: new Date().toISOString()
        });
        
        // جلب بيانات المستخدم المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || userData;
        
        // حساب الوقت المتبقي
        const now = Date.now();
        const timeRemaining = Math.max(0, competitionData.endTime - now);
        const timeRemainingFormatted = formatTimeRemaining(timeRemaining);
        
        return {
            success: true,
            data: {
                newBalance: updatedUserData.dogsBalance,
                userTickets: competitionData.userTickets[userId],
                totalTickets: competitionData.totalTickets,
                prizePool: competitionData.prizePool,
                contestEndTime: competitionData.endTime,
                timeRemaining: timeRemaining,
                timeRemainingFormatted: timeRemainingFormatted,
                userCompetitionTickets: newTicketCount,
                updatedUserData: updatedUserData
            }
        };
    } catch (error) {
        console.error('Buy tickets error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'BUY_TICKETS_ERROR'
        };
    }
}

async function handleGetCompetitionLeaderboard(env) {
    try {
        // تأكد من وجود مسابقة نشطة
        const competitionData = await ensureAndGetCompetition(env);
        
        if (!competitionData) {
            return {
                success: false,
                error: 'No active competition found',
                errorCode: 'NO_ACTIVE_COMPETITION'
            };
        }
        
        const userTickets = competitionData.userTickets || {};
        const leaderboard = [];
        
        for (const [userId, tickets] of Object.entries(userTickets)) {
            if (tickets > 0) {
                const userResult = await handleDbGet(env, `users/${userId}`);
                if (userResult.success && userResult.data) {
                    // تخطي المستخدمين المحظورين من المتصدرين
                    if (userResult.data.isBlocked) continue;
                    
                    leaderboard.push({
                        userId: userId,
                        name: userResult.data.name || 'Anonymous',
                        photoUrl: userResult.data.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png',
                        tickets: tickets
                    });
                }
            }
        }
        
        leaderboard.sort((a, b) => b.tickets - a.tickets);
        
        return {
            success: true,
            data: {
                leaderboard: leaderboard.slice(0, 10),
                contest: {
                    totalTickets: competitionData.totalTickets || 0,
                    prizePool: competitionData.prizePool || 0,
                    endTime: competitionData.endTime,
                    startTime: competitionData.startTime,
                    timeRemaining: competitionData.timeRemaining,
                    timeRemainingFormatted: competitionData.timeRemainingFormatted,
                    isActive: competitionData.isActiveNow
                }
            }
        };
    } catch (error) {
        console.error('Get competition leaderboard error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_COMPETITION_LEADERBOARD_ERROR'
        };
    }
}

async function handleGetPreviousWinners(env) {
    try {
        const winnersResult = await handleDbGet(env, 'competition/winners');
        const winnersData = winnersResult.data || {};
        
        const winners = [];
        
        for (const [key, winner] of Object.entries(winnersData)) {
            if (winner.userId) {
                const userResult = await handleDbGet(env, `users/${winner.userId}`);
                if (userResult.success && userResult.data) {
                    // تخطي المستخدمين المحظورين
                    if (userResult.data.isBlocked) continue;
                    
                    winners.push({
                        userId: winner.userId,
                        name: userResult.data.name || 'Anonymous',
                        photoUrl: userResult.data.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png',
                        tickets: winner.tickets || 0,
                        prize: winner.prize || 0,
                        timestamp: winner.timestamp || Date.now()
                    });
                }
            }
        }
        
        winners.sort((a, b) => b.timestamp - a.timestamp);
        
        return {
            success: true,
            data: {
                winners: winners.slice(0, 10)
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_PREVIOUS_WINNERS_ERROR'
        };
    }
}

async function handleFlipCoin(env, userId, data) {
    try {
        const { betAmount, chosenSide } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // التحقق من صحة البيانات
        if (!betAmount || !chosenSide) {
            return { 
                success: false, 
                error: 'Missing required parameters',
                errorCode: 'MISSING_PARAMETERS'
            };
        }
        
        const betAmountNum = parseInt(betAmount);
        
        if (isNaN(betAmountNum) || betAmountNum <= 0) {
            return { 
                success: false, 
                error: 'Invalid bet amount',
                errorCode: 'INVALID_BET_AMOUNT'
            };
        }
        
        if (chosenSide !== 'glx' && chosenSide !== 'gold') {
            return { 
                success: false, 
                error: 'Invalid side chosen (must be glx or gold)',
                errorCode: 'INVALID_SIDE'
            };
        }
        
        // جلب بيانات المستخدم
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        // التحقق من الحدود
        const configResult = await handleGetConfig(env);
        const settings = configResult.data?.settings || {};
        
        const MIN_BET = settings.coinFlipMinBet || 1000;
        const MAX_BET = settings.coinFlipMaxBet || 100000;
        
        if (betAmountNum < MIN_BET) {
            return { 
                success: false, 
                error: `Minimum bet is ${MIN_BET.toLocaleString()} GLX`,
                errorCode: 'MINIMUM_BET_REQUIRED'
            };
        }
        
        if (betAmountNum > MAX_BET) {
            return { 
                success: false, 
                error: `Maximum bet is ${MAX_BET.toLocaleString()} GLX`,
                errorCode: 'MAXIMUM_BET_EXCEEDED'
            };
        }
        
        // التحقق من الرصيد
        if (userData.dogsBalance < betAmountNum) {
            return { 
                success: false, 
                error: 'Insufficient GLX balance',
                errorCode: 'INSUFFICIENT_GLX_BALANCE',
                data: {
                    currentBalance: userData.dogsBalance,
                    requiredAmount: betAmountNum,
                    difference: betAmountNum - userData.dogsBalance
                }
            };
        }
        
        // التحقق من حد المكاسب اليومي
        const today = new Date().toDateString();
        const dailyLimit = settings.coinFlipDailyLimit || 1000000;
        
        // جلب إحصائيات اليوم
        const dailyStatsKey = `coinFlipDaily_${today.replace(/\s+/g, '_')}`;
        const dailyStats = userData[dailyStatsKey] || { totalWins: 0, totalProfit: 0 };
        
        // توليد النتيجة العشوائية
        const randomNumber = Math.random() * 100;
        const isWin = randomNumber < 45; // 45% فرصة للفوز
        const resultSide = isWin ? chosenSide : (chosenSide === 'glx' ? 'gold' : 'glx');
        const winAmount = isWin ? betAmountNum * 2 : 0;
        const netProfit = isWin ? betAmountNum : -betAmountNum;
        
        // معالجة الرهان
        let finalBalance;
        let transactionEntry;
        
        if (isWin) {
            // إذا فاز المستخدم
            const newDailyProfit = (dailyStats.totalProfit || 0) + betAmountNum;
            
            // التحقق من عدم تجاوز الحد اليومي
            if (newDailyProfit > dailyLimit) {
                // إذا تجاوز الحد اليومي، إرجاع الرهان فقط بدون ربح
                finalBalance = userData.dogsBalance;
                
                transactionEntry = {
                    type: 'coin_flip_daily_limit',
                    description: `Coin Flip Daily Limit Reached`,
                    amount: 0,
                    currency: 'GLX',
                    date: new Date().toISOString(),
                    timestamp: Date.now(),
                    betType: 'refund',
                    betSide: chosenSide,
                    betAmount: betAmountNum,
                    status: 'daily_limit_reached',
                    note: `Daily profit limit of ${dailyLimit.toLocaleString()} GLX reached`
                };
            } else {
                // إضافة المكسب الكامل
                finalBalance = (userData.dogsBalance || 0) + betAmountNum;
                
                transactionEntry = {
                    type: 'coin_flip_win',
                    description: `Coin Flip Win (${chosenSide.toUpperCase()})`,
                    amount: winAmount,
                    currency: 'GLX',
                    date: new Date().toISOString(),
                    timestamp: Date.now(),
                    betType: 'win',
                    betSide: chosenSide,
                    betAmount: betAmountNum,
                    netProfit: betAmountNum,
                    status: 'won'
                };
            }
        } else {
            // إذا خسر المستخدم
            finalBalance = userData.dogsBalance - betAmountNum;
            
            transactionEntry = {
                type: 'coin_flip_loss',
                description: `Coin Flip Loss (${chosenSide.toUpperCase()})`,
                amount: 0,
                currency: 'GLX',
                date: new Date().toISOString(),
                timestamp: Date.now(),
                betType: 'loss',
                betSide: chosenSide,
                betAmount: betAmountNum,
                netProfit: -betAmountNum,
                status: 'lost'
            };
        }
        
        // تحديث الرصيد
        await handleDbUpdate(env, `users/${userId}`, {
            dogsBalance: finalBalance,
            lastUpdated: Date.now(),
            lastCoinFlip: Date.now(),
            lastActivity: Date.now()
        });
        
        // تسجيل العملية في السجل
        await handleDbPush(env, `users/${userId}/history`, transactionEntry);
        
        // تحديث الإحصائيات
        const gameStatsUpdates = {
            totalCoinFlipPlays: (userData.totalCoinFlipPlays || 0) + 1,
            totalCoinFlipProfit: (userData.totalCoinFlipProfit || 0) + netProfit,
            lastCoinFlipResult: isWin ? 'win' : 'loss',
            lastCoinFlipDate: Date.now()
        };
        
        if (isWin) {
            gameStatsUpdates.totalCoinFlipWins = (userData.totalCoinFlipWins || 0) + 1;
        } else {
            gameStatsUpdates.totalCoinFlipLosses = (userData.totalCoinFlipLosses || 0) + 1;
        }
        
        // تحديث إحصائيات اليوم
        const updatedDailyStats = {
            totalPlays: (dailyStats.totalPlays || 0) + 1,
            totalProfit: isWin ? (dailyStats.totalProfit || 0) + betAmountNum : (dailyStats.totalProfit || 0),
            lastPlayDate: Date.now()
        };
        
        if (isWin) {
            updatedDailyStats.totalWins = (dailyStats.totalWins || 0) + 1;
        }
        
        // تحديث جميع الإحصائيات
        await handleDbUpdate(env, `users/${userId}`, {
            ...gameStatsUpdates,
            [dailyStatsKey]: updatedDailyStats,
            lastUpdated: Date.now()
        });
        
        // جلب البيانات المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || userData;
        
        // إعداد البيانات للإرجاع
        const responseData = {
            isWin: isWin,
            resultSide: resultSide,
            betAmount: betAmountNum,
            winAmount: winAmount,
            netProfit: netProfit,
            newBalance: finalBalance,
            currentBalance: updatedUserData.dogsBalance,
            gameStats: {
                totalPlays: gameStatsUpdates.totalCoinFlipPlays,
                totalWins: gameStatsUpdates.totalCoinFlipWins || 0,
                totalLosses: gameStatsUpdates.totalCoinFlipLosses || 0,
                totalProfit: gameStatsUpdates.totalCoinFlipProfit,
                winRate: gameStatsUpdates.totalCoinFlipPlays > 0 
                    ? ((gameStatsUpdates.totalCoinFlipWins || 0) / gameStatsUpdates.totalCoinFlipPlays * 100).toFixed(2) 
                    : '0.00'
            },
            dailyStats: updatedDailyStats,
            dailyLimit: dailyLimit,
            dailyLimitRemaining: Math.max(0, dailyLimit - updatedDailyStats.totalProfit),
            transactionId: Date.now().toString(),
            updatedUserData: {
                ...updatedUserData,
                dogsBalance: finalBalance
            }
        };
        
        // إذا تم الوصول للحد اليومي
        if (isWin && updatedDailyStats.totalProfit >= dailyLimit) {
            responseData.dailyLimitReached = true;
            responseData.warning = `Daily profit limit reached. Maximum daily profit is ${dailyLimit.toLocaleString()} GLX.`;
        }
        
        return {
            success: true,
            data: responseData
        };
        
    } catch (error) {
        console.error('Flip coin error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'FLIP_COIN_ERROR',
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
    }
}

async function handleRedeemPromoCode(env, userId, data) {
    try {
        const { code } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // جلب جميع البرومو كودات
        const promoCodesResult = await handleDbGet(env, 'promocodes');
        const promoCodes = promoCodesResult.data || {};
        
        let promoCodeData = null;
        let promoCodeKey = null;
        
        // البحث عن البرومو كود
        for (const [key, promo] of Object.entries(promoCodes)) {
            if (promo.code === code) {
                promoCodeData = promo;
                promoCodeKey = key;
                break;
            }
        }
        
        if (!promoCodeData) {
            return { 
                success: false, 
                error: 'Invalid or expired promo code',
                errorCode: 'INVALID_PROMO_CODE'
            };
        }
        
        // التحقق من حالة البرومو كود
        if (promoCodeData.status !== 'active') {
            return { 
                success: false, 
                error: 'This promo code is no longer active',
                errorCode: 'INACTIVE_PROMO_CODE'
            };
        }
        
        // التحقق من الحد الأقصى للاستخدام
        if (promoCodeData.usedCount >= promoCodeData.maxUsage) {
            return { 
                success: false, 
                error: 'This promo code has reached its usage limit',
                errorCode: 'PROMO_CODE_LIMIT_EXCEEDED'
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        const usedPromoCodes = userData.usedPromoCodes || [];
        
        // التحقق مما إذا كان المستخدم قد استخدم هذا البرومو كود من قبل
        let alreadyUsed = false;
        let usageCount = 0;
        
        for (const usedCode of usedPromoCodes) {
            if (typeof usedCode === 'object' && usedCode.code === code) {
                alreadyUsed = true;
                usageCount = usedCode.usageCount || 1;
                break;
            } else if (usedCode === code) {
                alreadyUsed = true;
                usageCount = 1;
                break;
            }
        }
        
        // التحقق من عدد مرات الاستخدام المسموح بها للمستخدم
        if (alreadyUsed && usageCount >= (promoCodeData.usagePerUser || 1)) {
            return { 
                success: false, 
                error: 'You have already used this promo code',
                errorCode: 'PROMO_CODE_ALREADY_USED'
            };
        }
        
        const rewardAmount = promoCodeData.rewardAmount || 0;
        const rewardType = promoCodeData.rewardType || 'glx';
        
        let updates = {};
        let historyDescription = '';
        
        // تطبيق المكافأة بناءً على النوع
        if (rewardType === 'glx') {
            const newBalance = (userData.dogsBalance || 0) + rewardAmount;
            updates.dogsBalance = newBalance;
            historyDescription = `Promo Code: ${code} (${rewardAmount} GLX)`;
        } else if (rewardType === 'ton') {
            const newBalance = (userData.tonBalance || 0) + rewardAmount;
            updates.tonBalance = newBalance;
            historyDescription = `Promo Code: ${code} (${rewardAmount} TON)`;
        } else if (rewardType === 'tickets') {
            // زيادة عدد التذاكر في المسابقة
            const competitionData = await ensureAndGetCompetition(env, userId);
            if (competitionData) {
                const currentUserTickets = competitionData.userTickets[userId] || 0;
                competitionData.userTickets[userId] = currentUserTickets + rewardAmount;
                competitionData.totalTickets = (competitionData.totalTickets || 0) + rewardAmount;
                competitionData.prizePool = competitionData.totalTickets * 0.001;
                
                await handleDbSet(env, 'competition/current', {
                    isActive: competitionData.isActive,
                    startTime: competitionData.startTime,
                    endTime: competitionData.endTime,
                    totalTickets: competitionData.totalTickets,
                    prizePool: competitionData.prizePool,
                    userTickets: competitionData.userTickets,
                    winners: competitionData.winners || [],
                    lastUpdated: Date.now()
                });
                
                updates.competitionTickets = competitionData.userTickets[userId];
                updates.lastTicketSync = Date.now();
            }
            historyDescription = `Promo Code: ${code} (${rewardAmount} Tickets)`;
        }
        
        // تحديث استخدام البرومو كود للمستخدم
        if (alreadyUsed) {
            // تحديث عدد مرات الاستخدام
            const updatedUsedCodes = usedPromoCodes.map(usedCode => {
                if (typeof usedCode === 'object' && usedCode.code === code) {
                    return { ...usedCode, usageCount: (usedCode.usageCount || 1) + 1 };
                } else if (usedCode === code) {
                    return { code: code, usageCount: 2 };
                }
                return usedCode;
            });
            updates.usedPromoCodes = updatedUsedCodes;
        } else {
            // إضافة البرومو كود الجديد
            usedPromoCodes.push({ code: code, usageCount: 1 });
            updates.usedPromoCodes = usedPromoCodes;
        }
        
        updates.lastUpdated = Date.now();
        
        // تحديث بيانات المستخدم
        await handleDbUpdate(env, `users/${userId}`, updates);
        
        // تحديث استخدام البرومو كود في قاعدة البيانات
        const newUsedCount = promoCodeData.usedCount + 1;
        await handleDbUpdate(env, `promocodes/${promoCodeKey}`, {
            usedCount: newUsedCount,
            lastUsed: Date.now(),
            lastUpdated: Date.now()
        });
        
        // تسجيل المستخدمين الذين استخدموا البرومو كود
        await handleDbPush(env, `promocodes/${promoCodeKey}/users`, {
            userId: userId,
            usedAt: Date.now(),
            rewardAmount: rewardAmount,
            rewardType: rewardType
        });
        
        // تسجيل في سجل المستخدم
        await handleDbPush(env, `users/${userId}/history`, {
            type: 'earn',
            description: historyDescription,
            amount: rewardAmount,
            currency: rewardType === 'ton' ? 'TON' : 'GLX',
            date: new Date().toISOString()
        });
        
        // جلب بيانات المستخدم المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || userData;
        
        return {
            success: true,
            data: {
                reward: rewardAmount,
                rewardType: rewardType,
                newBalance: rewardType === 'ton' ? updatedUserData.tonBalance : updatedUserData.dogsBalance,
                tickets: rewardType === 'tickets' ? updates.competitionTickets : undefined,
                updatedUserData: updatedUserData
            }
        };
    } catch (error) {
        console.error('Redeem promo code error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'REDEEM_PROMO_CODE_ERROR'
        };
    }
}

async function handleCreateTask(env, userId, data) {
    try {
        const { taskId, name, link, category, count, cost } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // إنشاء مهمة جديدة بحالة pending payment
        const newTask = {
            id: taskId,
            title: name,
            description: `Reward: ${category.toUpperCase()}`,
            link: link,
            reward: 2000,
            category: 'community',
            total: parseInt(count),
            remaining: parseInt(count),
            status: 'pending_payment',
            creator: userId,
            cost: parseFloat(cost),
            createdAt: Date.now(),
            paymentVerified: false,
            paymentCheckCount: 0,
            lastPaymentCheck: null,
            lastUpdated: Date.now()
        };
        
        await handleDbSet(env, `tasks/${taskId}`, newTask);
        
        // تسجيل طلب إنشاء المهمة
        await handleDbPush(env, `task_requests/${taskId}`, {
            userId: userId,
            taskData: newTask,
            requestedAt: Date.now(),
            status: 'awaiting_payment'
        });
        
        return {
            success: true,
            data: { 
                taskId: taskId,
                status: 'pending_payment',
                message: 'Task created successfully. Please wait 10 seconds for payment verification.',
                nextStep: 'verifyPayment',
                verifyAfter: 10000 // 10 ثوانٍ
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'CREATE_TASK_ERROR'
        };
    }
}

async function handleVerifyTaskPayment(env, taskId) {
    try {
        const taskResult = await handleDbGet(env, `tasks/${taskId}`);
        if (!taskResult.success || !taskResult.data) {
            return { 
                success: false, 
                error: 'Task not found',
                errorCode: 'TASK_NOT_FOUND'
            };
        }
        
        const task = taskResult.data;
        const now = Date.now();
        
        // تحديث عدد مرات التحقق
        const checkCount = (task.paymentCheckCount || 0) + 1;
        
        await handleDbUpdate(env, `tasks/${taskId}`, { 
            paymentCheckCount: checkCount,
            lastPaymentCheck: now,
            lastUpdated: Date.now()
        });
        
        // التحقق اليدوي - محاكاة التحقق بعد 10 ثوانٍ
        const timeSinceCreation = now - (task.createdAt || 0);
        
        if (timeSinceCreation >= 10000) { // 10 ثوانٍ
            // تم التحقق من الدفع (محاكاة)
            await handleDbUpdate(env, `tasks/${taskId}`, { 
                status: 'active',
                paymentVerified: true,
                verifiedAt: now,
                activeSince: now,
                lastUpdated: Date.now()
            });
            
            // تحديث طلب المهمة
            await handleDbUpdate(env, `task_requests/${taskId}`, {
                status: 'payment_verified',
                verifiedAt: now,
                verifiedBy: 'system_auto'
            });
            
            return {
                success: true,
                data: { 
                    verified: true,
                    status: 'active',
                    message: 'Payment verified successfully. Task is now active.',
                    taskId: taskId,
                    verifiedAt: now
                }
            };
        } else {
            // الانتظار لمزيد من الوقت
            const timeRemaining = 10000 - timeSinceCreation;
            
            return {
                success: true,
                data: { 
                    verified: false,
                    status: 'pending_payment',
                    message: 'Payment verification in progress. Please wait...',
                    timeRemaining: Math.max(0, timeRemaining),
                    checkCount: checkCount,
                    nextCheckIn: Math.ceil(timeRemaining / 1000)
                }
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'VERIFY_TASK_PAYMENT_ERROR'
        };
    }
}

async function handleVerifyTaskChannel(env, userId, data) {
    try {
        const { taskId, channelUsername } = data;
        
        console.log(`Verifying channel membership for user ${userId} in channel ${channelUsername}`);
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // جلب بيانات المستخدم
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        const completedTasks = userData.completedTasks || {};
        
        // التحقق مما إذا كانت المهمة مكتملة بالفعل
        if (completedTasks[taskId]) {
            return { 
                success: true,
                data: {
                    alreadyCompleted: true,
                    verified: true,
                    message: 'Task already completed.',
                    reward: completedTasks[taskId].reward || 0,
                    newBalance: userData.dogsBalance,
                    taskStatus: 'already_completed',
                    updatedUserData: userData
                }
            };
        }
        
        // تنظيف اسم القناة
        let cleanChannelUsername = channelUsername;
        
        if (cleanChannelUsername.includes('t.me/')) {
            cleanChannelUsername = cleanChannelUsername.split('t.me/')[1];
        }
        
        if (cleanChannelUsername.startsWith('@')) {
            cleanChannelUsername = cleanChannelUsername.substring(1);
        }
        
        console.log(`Cleaned channel username: ${cleanChannelUsername}`);
        
        // جلب Bot Token
        const botToken = env.TELEGRAM_BOT_TOKEN || '7066931017:AAHwuXbgaKHNrHrbf6jaoC8LDk0lSCPimgI';
        
        if (!botToken) {
            return { 
                success: false, 
                error: 'Bot token not configured',
                errorCode: 'BOT_TOKEN_MISSING'
            };
        }
        
        // استخدام Telegram Bot API للتحقق من عضوية المستخدم
        const chatMemberUrl = `https://api.telegram.org/bot${botToken}/getChatMember`;
        
        console.log(`Calling Telegram API: ${chatMemberUrl}`);
        console.log(`Request data: chat_id=@${cleanChannelUsername}, user_id=${userId}`);
        
        let telegramResult;
        
        try {
            // المحاولة الأولى: استخدام @username
            const response = await fetch(chatMemberUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: `@${cleanChannelUsername}`,
                    user_id: parseInt(userId)
                })
            });
            
            console.log(`Telegram API response status: ${response.status}`);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Telegram API error: ${errorText}`);
                
                // محاولة بديلة باستخدام numeric chat_id
                try {
                    // استعلام عن معلومات القناة للحصول على chat_id الرقمي
                    const getChatUrl = `https://api.telegram.org/bot${botToken}/getChat`;
                    const getChatResponse = await fetch(getChatUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: `@${cleanChannelUsername}`
                        })
                    });
                    
                    if (getChatResponse.ok) {
                        const chatInfo = await getChatResponse.json();
                        console.log(`Chat info: ${JSON.stringify(chatInfo)}`);
                        
                        if (chatInfo.ok && chatInfo.result) {
                            const numericChatId = chatInfo.result.id;
                            console.log(`Found numeric chat ID: ${numericChatId}`);
                            
                            // إعادة المحاولة باستخدام numeric chat_id
                            const retryResponse = await fetch(chatMemberUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: numericChatId,
                                    user_id: parseInt(userId)
                                })
                            });
                            
                            if (retryResponse.ok) {
                                telegramResult = await retryResponse.json();
                            } else {
                                throw new Error('Failed with numeric chat ID too');
                            }
                        }
                    }
                } catch (fallbackError) {
                    console.error('Fallback verification failed:', fallbackError);
                    return { 
                        success: false, 
                        error: 'Failed to verify channel membership. Please make sure you have joined the channel and try again.',
                        errorCode: 'TELEGRAM_API_ERROR',
                        data: {
                            verificationStatus: 'failed',
                            errorDetails: errorText,
                            debug: {
                                channelUsername: cleanChannelUsername,
                                userId: userId
                            }
                        }
                    };
                }
            } else {
                telegramResult = await response.json();
            }
            
            console.log(`Telegram API result: ${JSON.stringify(telegramResult)}`);
            
            if (!telegramResult.ok) {
                return {
                    success: false,
                    error: 'Unable to verify membership. Please try again.',
                    errorCode: 'TELEGRAM_API_FAILED',
                    data: {
                        telegramResult: telegramResult,
                        verificationStatus: 'api_failed'
                    }
                };
            }
            
            // التحقق من حالة العضوية
            const memberStatus = telegramResult.result.status;
            const isMember = memberStatus === 'member' || 
                           memberStatus === 'administrator' || 
                           memberStatus === 'creator';
            
            console.log(`User ${userId} membership status: ${memberStatus}, isMember: ${isMember}`);
            
            if (!isMember) {
                return { 
                    success: false, 
                    error: 'You must join the channel first! Please join the channel and try again.',
                    errorCode: 'NOT_CHANNEL_MEMBER',
                    data: {
                        verificationStatus: 'not_member',
                        channelUsername: cleanChannelUsername,
                        currentStatus: memberStatus,
                        requiredStatus: ['member', 'administrator', 'creator']
                    }
                };
            }
            
            // المكافأة من الإعدادات
            const configResult = await handleGetConfig(env);
            const settings = configResult.data?.settings || {};
            const TASK_CHANNEL_REWARD = settings.taskChannelReward || 2000;
            
            // تحديث بيانات المهمة
            completedTasks[taskId] = {
                completedAt: Date.now(),
                channel: cleanChannelUsername,
                reward: TASK_CHANNEL_REWARD,
                status: 'completed',
                verifiedAt: Date.now()
            };
            
            const newBalance = (userData.dogsBalance || 0) + TASK_CHANNEL_REWARD;
            
            // تحديث المستخدم
            await handleDbUpdate(env, `users/${userId}`, { 
                completedTasks: completedTasks,
                dogsBalance: newBalance,
                lastTaskCompletion: Date.now(),
                lastUpdated: Date.now()
            });
            
            // تحديث المهمة في قاعدة البيانات
            const taskResult = await handleDbGet(env, `tasks/${taskId}`);
            if (taskResult.success && taskResult.data) {
                const task = taskResult.data;
                if (task.remaining !== undefined && task.remaining > 0) {
                    await handleDbUpdate(env, `tasks/${taskId}`, { 
                        remaining: task.remaining - 1,
                        lastCompleted: Date.now(),
                        lastCompletedBy: userId,
                        completedCount: (task.completedCount || 0) + 1,
                        lastUpdated: Date.now()
                    });
                }
            }
            
            // تسجيل في السجل
            await handleDbPush(env, `users/${userId}/history`, {
                type: 'earn',
                description: `Joined Telegram Channel: ${cleanChannelUsername}`,
                amount: TASK_CHANNEL_REWARD,
                currency: 'GLX',
                date: new Date().toISOString(),
                taskId: taskId,
                channel: cleanChannelUsername
            });
        
            // حفظ تفاصيل الإكمال
            await handleDbSet(env, `tasks/${taskId}/completions/${userId}`, {
                completedAt: Date.now(),
                reward: TASK_CHANNEL_REWARD,
                verified: true,
                channel: cleanChannelUsername,
                status: 'completed',
                userId: userId
            });
            
            // جلب البيانات المحدثة
            const updatedUserResult = await handleDbGet(env, `users/${userId}`);
            const updatedUserData = updatedUserResult.data || userData;
            
            return {
                success: true,
                data: {
                    verified: true,
                    reward: TASK_CHANNEL_REWARD,
                    newBalance: newBalance,
                    channel: cleanChannelUsername,
                    membershipStatus: memberStatus,
                    message: 'Channel membership verified successfully! Task completed.',
                    taskStatus: 'completed',
                    taskId: taskId,
                    completionTime: Date.now(),
                    updatedUserData: updatedUserData
                }
            };
            
        } catch (apiError) {
            console.error('Telegram API call failed:', apiError);
            return { 
                success: false, 
                error: 'Unable to verify channel membership at this time. Please try again later.',
                errorCode: 'TELEGRAM_API_CALL_FAILED',
                data: {
                    errorDetails: apiError.message,
                    verificationStatus: 'api_error'
                }
            };
        }
        
    } catch (error) {
        console.error('Verify task channel error:', error);
        return {
            success: false,
            error: 'An unexpected error occurred. Please try again.',
            errorCode: 'VERIFY_TASK_CHANNEL_ERROR',
            data: {
                errorDetails: error.message,
                verificationStatus: 'error'
            }
        };
    }
}

async function handleSpinSlots(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        if ((userData.extraSpins || 0) <= 0) {
            return { 
                success: false, 
                error: 'No spins left',
                errorCode: 'NO_SPINS_AVAILABLE'
            };
        }
        
        const newSpins = (userData.extraSpins || 1) - 1;
        await handleDbUpdate(env, `users/${userId}`, { 
            extraSpins: newSpins,
            lastUpdated: Date.now()
        });
        
        const symbols = ['🌟', '🪐', '💫', '⭐', '🚀', '🌌'];
        const results = [
            symbols[Math.floor(Math.random() * symbols.length)],
            symbols[Math.floor(Math.random() * symbols.length)],
            symbols[Math.floor(Math.random() * symbols.length)]
        ];
        
        let winAmount = 0;
        const resultString = results.join('');
        
        if (resultString === '🌟🌟🌟') winAmount = 10000;
        else if (resultString === '🪐🪐🪐') winAmount = 5000;
        else if (resultString === '💫💫💫') winAmount = 2500;
        else if (resultString === '⭐⭐⭐') winAmount = 1200;
        else if (results[0] === '🌟' && results[1] === '🌟') winAmount = 700;
        else if (results[1] === '🌟' && results[2] === '🌟') winAmount = 700;
        else if (results[0] === results[1] || results[1] === results[2] || results[0] === results[2]) winAmount = 500;
        
        if (winAmount > 0) {
            const newBalance = (userData.dogsBalance || 0) + winAmount;
            await handleDbUpdate(env, `users/${userId}`, { 
                dogsBalance: newBalance,
                lastUpdated: Date.now()
            });
            
            await handleDbPush(env, `users/${userId}/history`, {
                type: 'earn',
                description: `Galaxy Slots Win (${resultString})`,
                amount: winAmount,
                currency: 'GLX',
                date: new Date().toISOString()
            });
            
            // جلب بيانات المستخدم المحدثة
            const updatedUserResult = await handleDbGet(env, `users/${userId}`);
            const updatedUserData = updatedUserResult.data || userData;
            
            return {
                success: true,
                data: {
                    results: results,
                    winAmount: winAmount,
                    newBalance: updatedUserData.dogsBalance,
                    newSpins: newSpins,
                    updatedUserData: updatedUserData
                }
            };
        } else {
            // جلب بيانات المستخدم المحدثة
            const updatedUserResult = await handleDbGet(env, `users/${userId}`);
            const updatedUserData = updatedUserResult.data || userData;
            
            return {
                success: true,
                data: {
                    results: results,
                    winAmount: 0,
                    newBalance: updatedUserData.dogsBalance,
                    newSpins: newSpins,
                    updatedUserData: updatedUserData
                }
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'SPIN_SLOTS_ERROR'
        };
    }
}

async function handleAddExtraSpin(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        const newSpins = (userData.extraSpins || 0) + 1;
        await handleDbUpdate(env, `users/${userId}`, { 
            extraSpins: newSpins,
            lastUpdated: Date.now()
        });
        
        await handleDbPush(env, `users/${userId}/history`, {
            type: 'earn',
            description: 'Extra Spin from Ad',
            amount: 1,
            currency: 'Spin',
            date: new Date().toISOString()
        });
        
        // جلب البيانات المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || userData;
        
        return {
            success: true,
            data: {
                newSpins: newSpins,
                updatedUserData: updatedUserData
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'ADD_EXTRA_SPIN_ERROR'
        };
    }
}

async function handleClaimDailyBonus(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        const now = Date.now();
        const msInDay = 86400000;
        
        let streak = userData.dailyStreak || 0;
        const lastClaim = userData.lastDailyClaim || 0;
        
        if (now - lastClaim > 172800000) {
            streak = 0;
        }
        
        const settings = await getOrInitAppSettings(env);
        const rewards = settings.dailyRewards || [2000, 3000, 5000, 7000, 9000, 12000, 15000];
        const reward = rewards[Math.min(streak, rewards.length - 1)] || 100;
        
        const updates = {
            lastDailyClaim: now,
            dailyStreak: streak + 1,
            dogsBalance: (userData.dogsBalance || 0) + reward,
            lastUpdated: Date.now()
        };
        
        await handleDbUpdate(env, `users/${userId}`, updates);
        
        await handleDbPush(env, `users/${userId}/history`, {
            type: 'earn',
            description: `Daily Login Day ${streak + 1}`,
            amount: reward,
            currency: 'GLX',
            date: new Date().toISOString()
        });
        
        // جلب بيانات المستخدم المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || userData;
        
        return {
            success: true,
            data: {
                reward: reward,
                lastDailyClaim: now,
                dailyStreak: streak + 1,
                newBalance: updatedUserData.dogsBalance,
                updatedUserData: updatedUserData
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'CLAIM_DAILY_BONUS_ERROR'
        };
    }
}

async function handleGetTransactionHistory(env, userId, limit = 50) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const historyResult = await handleDbGet(env, `users/${userId}/history`);
        const historyData = historyResult.data || {};
        
        const historyArray = Object.values(historyData)
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, limit);
        
        return {
            success: true,
            data: {
                history: historyArray
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_TRANSACTION_HISTORY_ERROR'
        };
    }
}

async function handleGetUserWithdrawals(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const withdrawalsResult = await handleDbGet(env, 'withdrawQueue');
        const withdrawalsData = withdrawalsResult.data || {};
        
        const userWithdrawals = [];
        
        for (const [key, withdrawal] of Object.entries(withdrawalsData)) {
            if (withdrawal.userId === userId) {
                userWithdrawals.push({
                    key: key,
                    ...withdrawal
                });
            }
        }
        
        userWithdrawals.sort((a, b) => (b.ts || b.timestamp || 0) - (a.ts || a.timestamp || 0));
        
        return {
            success: true,
            data: {
                withdrawals: userWithdrawals
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_USER_WITHDRAWALS_ERROR'
        };
    }
}

async function handleGetWithdrawalHistory(env) {
    try {
        // قراءة السحوبات المكتملة فقط — البوت بيحط الحالة "paid" بعد الدفع الفعلي
        const completedResult = await handleDbGet(env, 'withdrawQueue');
        const completedData = completedResult.data || {};
        
        const withdrawals = [];
        
        for (const [key, withdrawal] of Object.entries(completedData)) {
            // التحقق من أن السحب مكتمل بالفعل (تم دفعه فعليًا من البوت)
            if (withdrawal.status === 'paid') {
                const userResult = await handleDbGet(env, `users/${withdrawal.userId}`);
                if (userResult.success && userResult.data) {
                    // تخطي المستخدمين المحظورين
                    if (userResult.data.isBlocked) continue;
                    
                    withdrawals.push({
                        ...withdrawal,
                        key: key,
                        name: userResult.data.name || 'Anonymous',
                        photoUrl: userResult.data.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png'
                    });
                }
            }
        }
        
        withdrawals.sort((a, b) => (b.completedAt || b.updatedAt || b.timestamp || 0) - (a.completedAt || a.updatedAt || a.timestamp || 0));
        
        return {
            success: true,
            data: {
                withdrawals: withdrawals.slice(0, 50),
                completedCount: withdrawals.length,
                message: 'Showing completed withdrawals only'
            }
        };
    } catch (error) {
        console.error('Get withdrawal history error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_WITHDRAWAL_HISTORY_ERROR'
        };
    }
}

async function handleGetWithdrawalStats(env) {
    try {
        const queueResult = await handleDbGet(env, 'withdrawQueue');
        const queueData = queueResult.data || {};
        
        let completedCount = 0;
        let totalPaid = 0;
        let pendingCount = 0;
        
        for (const [key, withdrawal] of Object.entries(queueData)) {
            // البوت بيحط "paid" لما يخلص الدفع الفعلي على الشبكة
            if (withdrawal.status === 'paid') {
                completedCount++;
                totalPaid += parseFloat(withdrawal.sentAmount ?? withdrawal.ton ?? withdrawal.amount ?? 0);
            } else if (withdrawal.status === 'pending') {
                pendingCount++;
            }
        }
        
        return {
            success: true,
            data: {
                completedCount: completedCount,
                totalPaid: totalPaid.toFixed(4),
                pendingCount: pendingCount,
                totalWithdrawals: completedCount + pendingCount
            }
        };
    } catch (error) {
        console.error('Get withdrawal stats error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_WITHDRAWAL_STATS_ERROR'
        };
    }
}

async function handleGetReferredUsers(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        const referredUsers = userData.referredUsers || [];
        
        const referredUsersData = [];
        
        for (const referredUserId of referredUsers) {
            const referredUserResult = await handleDbGet(env, `users/${referredUserId}`);
            if (referredUserResult.success && referredUserResult.data) {
                referredUsersData.push({
                    userId: referredUserId,
                    name: referredUserResult.data.name || 'Anonymous User',
                    photoUrl: referredUserResult.data.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png',
                    joinDate: referredUserResult.data.joinDate,
                    dogsBalance: referredUserResult.data.dogsBalance || 0
                });
            }
        }
        
        return {
            success: true,
            data: {
                referredUsers: referredUsersData
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_REFERRED_USERS_ERROR'
        };
    }
}

async function handleGetTasks(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const tasksResult = await handleDbGet(env, 'tasks');
        const tasksData = tasksResult.data || {};
        
        const activeTasks = [];
        
        for (const [taskId, task] of Object.entries(tasksData)) {
            if (task.status === 'active' && (task.remaining === undefined || task.remaining > 0)) {
                activeTasks.push({
                    id: taskId,
                    ...task
                });
            }
        }
        
        return {
            success: true,
            data: {
                tasks: activeTasks
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_TASKS_ERROR'
        };
    }
}

async function handleVerifyTaskCompletion(env, userId, data) {
    try {
        const { taskId, reward, title, link, channelUsername, claimReward = false } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        const userData = userResult.data;
        
        const taskResult = await handleDbGet(env, `tasks/${taskId}`);
        if (!taskResult.success || !taskResult.data) {
            return { 
                success: false, 
                error: 'Task not found',
                errorCode: 'TASK_NOT_FOUND'
            };
        }
        
        const task = taskResult.data;
        
        const completedTasks = userData.completedTasks || {};
        
        // التحقق مما إذا كانت المهمة مكتملة بالفعل
        if (completedTasks[taskId]) {
            return { 
                success: true,
                data: {
                    alreadyCompleted: true,
                    taskCompleted: true,
                    taskStatus: 'already_completed',
                    message: 'Task already completed.',
                    reward: completedTasks[taskId].reward || 0,
                    newBalance: userData.dogsBalance,
                    updatedUserData: userData
                }
            };
        }
        
        if (task.remaining !== undefined && task.remaining <= 0) {
            return { 
                success: false, 
                error: 'No rewards left for this task',
                errorCode: 'NO_TASK_REWARDS_LEFT'
            };
        }
        
        const rewardAmount = parseInt(reward);
        
        // التحقق من أن مكافأة المهمة تطابق القيمة المخزنة
        if (task.reward && rewardAmount !== task.reward) {
            return { 
                success: false, 
                error: `Invalid task reward: Expected ${task.reward}, got ${rewardAmount}`,
                errorCode: 'INVALID_TASK_REWARD'
            };
        }
        
        // إذا كانت claimReward = false (تحقق فقط)
        if (!claimReward) {
            return {
                success: true,
                data: {
                    taskAvailable: true,
                    taskId: taskId,
                    reward: rewardAmount,
                    title: title,
                    message: 'Task is available for completion',
                    userBalance: userData.dogsBalance,
                    taskStatus: 'available',
                    updatedUserData: userData
                }
            };
        }
        
        // إذا كانت claimReward = true (المطالبة بالمكافأة)
        const newBalance = (userData.dogsBalance || 0) + rewardAmount;
        
        const updates = {};
        if (task.remaining !== undefined) {
            updates.remaining = task.remaining - 1;
            updates.lastUpdated = Date.now();
        }
        
        const userUpdates = {
            dogsBalance: newBalance,
            lastUpdated: Date.now(),
            lastActivity: Date.now()
        };
        
        // تحديث المهمة كمكتملة للمستخدم
        completedTasks[taskId] = {
            completedAt: Date.now(),
            reward: rewardAmount,
            taskTitle: title,
            verified: true
        };
        
        userUpdates.completedTasks = completedTasks;
        
        // تحديث بيانات المستخدم
        await handleDbUpdate(env, `users/${userId}`, userUpdates);
        
        if (Object.keys(updates).length > 0) {
            await handleDbUpdate(env, `tasks/${taskId}`, updates);
        }
        
        await handleDbPush(env, `users/${userId}/history`, {
            type: 'earn',
            description: `Mission: ${title}`,
            amount: rewardAmount,
            currency: 'GLX',
            date: new Date().toISOString(),
            taskId: taskId,
            link: link,
            channelUsername: channelUsername
        });
        
        // جلب بيانات المستخدم المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || { ...userData, ...userUpdates };
        
        return {
            success: true,
            data: {
                taskCompleted: true,
                reward: rewardAmount,
                newBalance: updatedUserData.dogsBalance,
                message: 'Task completed successfully and reward claimed!',
                updatedUserData: updatedUserData,
                taskId: taskId
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'VERIFY_TASK_COMPLETION_ERROR'
        };
    }
}

async function handleReferral(env, userId, referrerId) {
    try {
        if (!referrerId || referrerId === userId) {
            return { 
                success: false, 
                error: 'Invalid referrer',
                errorCode: 'INVALID_REFERRER'
            };
        }
        
        // التحقق من حظر المستخدمين
        const userBlockCheck = await checkUserBlocked(env, userId);
        const referrerBlockCheck = await checkUserBlocked(env, referrerId);
        
        if ((userBlockCheck && userBlockCheck.isBlocked) || (referrerBlockCheck && referrerBlockCheck.isBlocked)) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    userBlocked: userBlockCheck ? userBlockCheck.isBlocked : false,
                    referrerBlocked: referrerBlockCheck ? referrerBlockCheck.isBlocked : false,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${userBlockCheck?.reason || referrerBlockCheck?.reason}\nViolation: ${userBlockCheck?.violation || referrerBlockCheck?.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (userResult.success && userResult.data && userResult.data.referrer) {
            return { 
                success: false, 
                error: 'Already referred',
                errorCode: 'ALREADY_REFERRED'
            };
        }
        
        await handleDbUpdate(env, `users/${userId}`, { 
            referrer: referrerId, 
            joinDate: Date.now(),
            lastUpdated: Date.now()
        });
        
        const referrerResult = await handleDbGet(env, `users/${referrerId}`);
        if (!referrerResult.success || !referrerResult.data) {
            return { 
                success: true, 
                data: { referred: true } 
            };
        }
        
        const referrerData = referrerResult.data;
        
        const referredUsers = referrerData.referredUsers || [];
        if (!referredUsers.includes(userId)) {
            referredUsers.push(userId);
        }
        
        // مكافأة الإحالة 100,000 GLX
        const referralReward = 100000;
        
        const updates = {
            referredUsers: referredUsers,
            referrals: (referrerData.referrals || 0) + 1,
            dogsBalance: (referrerData.dogsBalance || 0) + referralReward,
            lastUpdated: Date.now()
        };
        
        await handleDbUpdate(env, `users/${referrerId}`, updates);
        
        await handleDbPush(env, `users/${referrerId}/history`, {
            type: 'referral',
            description: 'Friend Invited',
            amount: referralReward,
            currency: 'GLX',
            date: new Date().toISOString()
        });
        
        // جلب البيانات المحدثة
        const updatedReferrerResult = await handleDbGet(env, `users/${referrerId}`);
        const updatedReferrerData = updatedReferrerResult.data || referrerData;
        
        return {
            success: true,
            data: { 
                referred: true,
                referralReward: referralReward,
                updatedUserData: updatedReferrerData
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'HANDLE_REFERRAL_ERROR'
        };
    }
}

async function handleTestFirebase(env) {
    try {
        console.log('Testing Firebase connection...');
        console.log('API Key:', env.FIREBASE_API_KEY ? 'Present' : 'Missing');
        console.log('DB URL:', env.FIREBASE_DATABASE_URL);
        
        // اختبار الاتصال
        const testPath = 'connection_test';
        const timestamp = Date.now();
        
        // محاولة الكتابة
        const writeUrl = await getFirebaseUrl(env, testPath);
        console.log('Write URL:', writeUrl);
        
        const writeResponse = await fetch(writeUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                test: true, 
                timestamp: timestamp,
                message: 'Firebase connection test'
            })
        });
        
        console.log('Write status:', writeResponse.status);
        
        if (!writeResponse.ok) {
            const errorText = await writeResponse.text();
            console.error('Write error:', errorText);
            throw new Error(`Write failed: ${writeResponse.status} - ${errorText}`);
        }
        
        const writeResult = await writeResponse.json();
        console.log('Write result:', writeResult);
        
        // محاولة القراءة
        const readResponse = await fetch(writeUrl);
        console.log('Read status:', readResponse.status);
        
        if (!readResponse.ok) {
            const errorText = await readResponse.text();
            throw new Error(`Read failed: ${writeResponse.status} - ${errorText}`);
        }
        
        const readData = await readResponse.json();
        console.log('Read data:', readData);
        
        return {
            success: true,
            message: 'Firebase connection successful',
            data: {
                writeStatus: writeResponse.status,
                readStatus: readResponse.status,
                testData: readData,
                apiKeyLength: env.FIREBASE_API_KEY ? env.FIREBASE_API_KEY.length : 0,
                databaseUrl: env.FIREBASE_DATABASE_URL
            }
        };
    } catch (error) {
        console.error('Firebase test error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'FIREBASE_TEST_ERROR',
            debug: {
                apiKey: env.FIREBASE_API_KEY ? 'Present' : 'Missing',
                apiKeyFirst10: env.FIREBASE_API_KEY ? env.FIREBASE_API_KEY.substring(0, 10) + '...' : 'None',
                dbUrl: env.FIREBASE_DATABASE_URL,
                fullUrl: env.FIREBASE_DATABASE_URL ? `${env.FIREBASE_DATABASE_URL}/test.json` : 'No URL'
            }
        };
    }
}

async function handleGetUserData(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const userResult = await handleDbGet(env, `users/${userId}`);
        if (!userResult.success || !userResult.data) {
            return { 
                success: false, 
                error: 'User not found',
                errorCode: 'USER_NOT_FOUND'
            };
        }
        
        // جلب بيانات المسابقة الحالية للمستخدم
        const competitionData = await ensureAndGetCompetition(env, userId);
        
        if (!competitionData) {
            return {
                success: false,
                error: 'Failed to load competition data',
                errorCode: 'COMPETITION_DATA_LOAD_ERROR'
            };
        }
        
        // التأكد من تحديث حقل competitionTickets في بيانات المستخدم
        const currentUserTickets = competitionData.userTicketCount || 0;
        if (userResult.data.competitionTickets !== currentUserTickets) {
            await handleDbUpdate(env, `users/${userId}`, { 
                competitionTickets: currentUserTickets,
                lastTicketSync: Date.now(),
                lastUpdated: Date.now()
            });
        }
        
        // جلب البيانات المحدثة
        const updatedUserResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = updatedUserResult.data || userResult.data;
        
        return {
            success: true,
            data: {
                userData: {
                    ...updatedUserData,
                    competitionTickets: currentUserTickets
                },
                contest: {
                    yourTickets: currentUserTickets,
                    totalTickets: competitionData.totalTickets || 0,
                    prizePool: competitionData.prizePool || 0,
                    isActive: competitionData.isActiveNow,
                    endTime: competitionData.endTime,
                    startTime: competitionData.startTime,
                    timeRemaining: competitionData.timeRemaining,
                    timeRemainingFormatted: competitionData.timeRemainingFormatted
                }
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_USER_DATA_ERROR'
        };
    }
}

async function handleRefreshCompetition(env) {
    try {
        const competitionData = await ensureAndGetCompetition(env);
        
        if (!competitionData) {
            return {
                success: false,
                error: 'Failed to refresh competition',
                errorCode: 'REFRESH_COMPETITION_ERROR'
            };
        }
        
        return {
            success: true,
            data: {
                competitionData: {
                    isActive: competitionData.isActive,
                    startTime: competitionData.startTime,
                    endTime: competitionData.endTime,
                    totalTickets: competitionData.totalTickets || 0,
                    prizePool: competitionData.prizePool || 0,
                    timeRemaining: competitionData.timeRemaining,
                    timeRemainingFormatted: competitionData.timeRemainingFormatted,
                    isActiveNow: competitionData.isActiveNow
                }
            }
        };
    } catch (error) {
        console.error('Error refreshing competition:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'REFRESH_COMPETITION_ERROR'
        };
    }
}

async function handleVerifyTelegramMembership(env, userId, data) {
    try {
        const { channelUsername } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        const botToken = env.TELEGRAM_BOT_TOKEN || '7066931017:AAHwuXbgaKHNrHrbf6jaoC8LDk0lSCPimgI';
        
        if (!botToken) {
            return { 
                success: false, 
                error: 'Bot token not configured',
                errorCode: 'BOT_TOKEN_MISSING'
            };
        }
        
        // تنظيف اسم القناة
        let cleanChannelUsername = channelUsername;
        
        if (cleanChannelUsername.includes('t.me/')) {
            cleanChannelUsername = cleanChannelUsername.split('t.me/')[1];
        }
        
        if (cleanChannelUsername.startsWith('@')) {
            cleanChannelUsername = cleanChannelUsername.substring(1);
        }
        
        const chatMemberUrl = `https://api.telegram.org/bot${botToken}/getChatMember`;
        
        const response = await fetch(chatMemberUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: `@${cleanChannelUsername}`,
                user_id: parseInt(userId)
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            return { 
                success: false, 
                error: 'Failed to verify membership',
                errorCode: 'TELEGRAM_API_ERROR',
                details: errorText
            };
        }
        
        const result = await response.json();
        
        const isMember = result.ok && 
            (result.result.status === 'member' || 
             result.result.status === 'administrator' || 
             result.result.status === 'creator');
        
        return {
            success: true,
            data: {
                isMember: isMember,
                channelUsername: cleanChannelUsername,
                userId: userId,
                status: result.result.status,
                requiredStatus: ['member', 'administrator', 'creator']
            }
        };
        
    } catch (error) {
        console.error('Verify telegram membership error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'VERIFY_TELEGRAM_MEMBERSHIP_ERROR'
        };
    }
}

async function handleSyncUserCompetitionTickets(env, userId) {
    try {
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // جلب بيانات المسابقة الحالية
        const competitionData = await ensureAndGetCompetition(env, userId);
        
        if (!competitionData) {
            return {
                success: false,
                error: 'Failed to load competition data',
                errorCode: 'COMPETITION_DATA_LOAD_ERROR'
            };
        }
        
        const currentTickets = competitionData.userTicketCount || 0;
        
        // تحديث بيانات المستخدم
        await handleDbUpdate(env, `users/${userId}`, {
            competitionTickets: currentTickets,
            lastTicketSync: Date.now(),
            lastUpdated: Date.now()
        });
        
        // جلب بيانات المستخدم المحدثة
        const userResult = await handleDbGet(env, `users/${userId}`);
        const updatedUserData = userResult.data || {};
        
        return {
            success: true,
            data: {
                competitionTickets: currentTickets,
                userData: updatedUserData,
                contest: {
                    yourTickets: currentTickets,
                    totalTickets: competitionData.totalTickets || 0,
                    prizePool: competitionData.prizePool || 0,
                    isActive: competitionData.isActiveNow
                }
            }
        };
    } catch (error) {
        console.error('Error syncing user competition tickets:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'SYNC_USER_COMPETITION_TICKETS_ERROR'
        };
    }
}

async function handleTestTelegramApi(env, userId, data) {
    try {
        const { channelUsername } = data;
        
        console.log(`Testing Telegram API for channel: ${channelUsername}, user: ${userId}`);
        
        const botToken = env.TELEGRAM_BOT_TOKEN || '7066931017:AAHwuXbgaKHNrHrbf6jaoC8LDk0lSCPimgI';
        
        if (!botToken) {
            return {
                success: false,
                error: 'Bot token not configured',
                errorCode: 'BOT_TOKEN_MISSING'
            };
        }
        
        // اختبار 1: الحصول على معلومات البوت
        const getMeUrl = `https://api.telegram.org/bot${botToken}/getMe`;
        const getMeResponse = await fetch(getMeUrl);
        const getMeResult = await getMeResponse.json();
        
        console.log('Bot info:', getMeResult);
        
        // اختبار 2: الحصول على معلومات القناة
        let cleanChannelUsername = channelUsername;
        
        if (cleanChannelUsername.includes('t.me/')) {
            cleanChannelUsername = cleanChannelUsername.split('t.me/')[1];
        }
        
        if (cleanChannelUsername.startsWith('@')) {
            cleanChannelUsername = cleanChannelUsername.substring(1);
        }
        
        const getChatUrl = `https://api.telegram.org/bot${botToken}/getChat`;
        const getChatResponse = await fetch(getChatUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: `@${cleanChannelUsername}`
            })
        });
        
        const getChatResult = await getChatResponse.json();
        
        console.log('Channel info:', getChatResult);
        
        // اختبار 3: التحقق من عضوية المستخدم
        const chatMemberUrl = `https://api.telegram.org/bot${botToken}/getChatMember`;
        let membershipResult = null;
        
        if (getChatResult.ok && getChatResult.result) {
            // استخدام numeric chat_id إذا كان متاحًا
            const numericChatId = getChatResult.result.id;
            
            const chatMemberResponse = await fetch(chatMemberUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: numericChatId,
                    user_id: parseInt(userId)
                })
            });
            
            membershipResult = await chatMemberResponse.json();
        } else {
            // المحاولة باستخدام username
            const chatMemberResponse = await fetch(chatMemberUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: `@${cleanChannelUsername}`,
                    user_id: parseInt(userId)
                })
            });
            
            membershipResult = await chatMemberResponse.json();
        }
        
        console.log('Membership check:', membershipResult);
        
        return {
            success: true,
            data: {
                botInfo: getMeResult,
                channelInfo: getChatResult,
                membershipCheck: membershipResult,
                debug: {
                    channelUsername: cleanChannelUsername,
                    userId: userId,
                    botTokenExists: !!botToken,
                    botTokenFirst10: botToken.substring(0, 10) + '...'
                }
            }
        };
        
    } catch (error) {
        console.error('Test Telegram API error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'TEST_TELEGRAM_API_ERROR',
            stack: error.stack
        };
    }
}

async function migrateWithdrawals(env) {
    try {
        // جلب جميع السحوبات القديمة
        const oldWithdrawalsResult = await handleDbGet(env, 'withdrawals');
        const oldWithdrawals = oldWithdrawalsResult.data || {};
        
        let migratedCount = 0;
        let completedCount = 0;
        let pendingCount = 0;
        
        for (const [key, withdrawal] of Object.entries(oldWithdrawals)) {
            // تخطي إذا كان مجلدًا (يحوي /)
            if (key.includes('/')) continue;
            
            // إذا كان السحب مكتملاً
            if (withdrawal.status === 'completed' || withdrawal.processed === 'yes' || withdrawal.processed === true) {
                // نقل إلى withdrawals/completed
                await handleDbSet(env, `withdrawals/completed/${key}`, withdrawal);
                completedCount++;
                
                // حذف من الموقع القديم
                await handleDbSet(env, `withdrawals/${key}`, null);
                migratedCount++;
            } 
            // إذا كان السحب معلقاً
            else if (withdrawal.status === 'pending') {
                // نقل إلى withdrawals/pending
                await handleDbSet(env, `withdrawals/pending/${key}`, withdrawal);
                pendingCount++;
                
                // حذف من الموقع القديم
                await handleDbSet(env, `withdrawals/${key}`, null);
                migratedCount++;
            }
            // إذا كان مرفوضاً
            else if (withdrawal.status === 'rejected') {
                // نقل إلى withdrawals/rejected
                await handleDbSet(env, `withdrawals/rejected/${key}`, withdrawal);
                
                // حذف من الموقع القديم
                await handleDbSet(env, `withdrawals/${key}`, null);
                migratedCount++;
            }
        }
        
        return {
            success: true,
            data: {
                migratedCount: migratedCount,
                completedCount: completedCount,
                pendingCount: pendingCount,
                message: `Successfully migrated ${migratedCount} withdrawals`
            }
        };
    } catch (error) {
        console.error('Migration error:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'MIGRATION_ERROR',
            details: error.stack
        };
    }
}

async function handleGetAllPromoCodes(env) {
    try {
        const promoCodesResult = await handleDbGet(env, 'promocodes');
        const promoCodes = promoCodesResult.data || {};
        
        const promoCodeList = [];
        
        for (const [key, promo] of Object.entries(promoCodes)) {
            promoCodeList.push({
                id: key,
                ...promo
            });
        }
        
        // ترتيب حسب تاريخ الإنشاء (الأحدث أولاً)
        promoCodeList.sort((a, b) => b.createdAt - a.createdAt);
        
        return {
            success: true,
            data: {
                promoCodes: promoCodeList,
                totalCount: promoCodeList.length
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_ALL_PROMO_CODES_ERROR'
        };
    }
}

async function handleGetActivePromoCodes(env) {
    try {
        const promoCodesResult = await handleDbGet(env, 'promocodes');
        const promoCodes = promoCodesResult.data || {};
        
        const activePromoCodes = [];
        
        for (const [key, promo] of Object.entries(promoCodes)) {
            if (promo.status === 'active') {
                // التحقق من الحد الأقصى للاستخدام
                if (promo.usedCount < promo.maxUsage) {
                    activePromoCodes.push({
                        id: key,
                        ...promo
                    });
                }
            }
        }
        
        // ترتيب حسب تاريخ الإنشاء (الأحدث أولاً)
        activePromoCodes.sort((a, b) => b.createdAt - a.createdAt);
        
        return {
            success: true,
            data: {
                activePromoCodes: activePromoCodes,
                activeCount: activePromoCodes.length
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_ACTIVE_PROMO_CODES_ERROR'
        };
    }
}

async function handleCreatePromoCode(env, userId, data) {
    try {
        const { code, rewardAmount, rewardType, maxUsage, usagePerUser, description, isPublic } = data;
        
        // التحقق من الحظر
        const blockCheck = await checkUserBlocked(env, userId);
        if (blockCheck && blockCheck.isBlocked) {
            return { 
                success: false, 
                error: 'ACCOUNT_BLOCKED',
                errorCode: 'ACCOUNT_BLOCKED',
                data: { 
                    isBlocked: true,
                    blockDetails: blockCheck,
                    blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                    redirectToBlockPage: true
                }
            };
        }
        
        // التحقق من صحة البيانات
        if (!code || !rewardAmount || !rewardType) {
            return { 
                success: false, 
                error: 'Missing required fields',
                errorCode: 'MISSING_FIELDS'
            };
        }
        
        // التحقق من صحة نوع المكافأة
        const validRewardTypes = ['glx', 'ton', 'tickets'];
        if (!validRewardTypes.includes(rewardType)) {
            return { 
                success: false, 
                error: 'Invalid reward type. Must be glx, ton, or tickets',
                errorCode: 'INVALID_REWARD_TYPE'
            };
        }
        
        // التحقق من أن الكود غير موجود مسبقًا
        const promoCodesResult = await handleDbGet(env, 'promocodes');
        const promoCodes = promoCodesResult.data || {};
        
        for (const [key, promo] of Object.entries(promoCodes)) {
            if (promo.code === code) {
                return { 
                    success: false, 
                error: 'Promo code already exists',
                errorCode: 'PROMO_CODE_EXISTS'
                };
            }
        }
        
        // إنشاء البرومو كود
        const promoId = `promo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const newPromoCode = {
            code: code,
            rewardAmount: parseFloat(rewardAmount),
            rewardType: rewardType,
            maxUsage: parseInt(maxUsage) || 100,
            usagePerUser: parseInt(usagePerUser) || 1,
            description: description || '',
            isPublic: isPublic !== false,
            status: 'active',
            usedCount: 0,
            createdAt: Date.now(),
            createdBy: userId,
            lastUpdated: Date.now()
        };
        
        // حفظ البرومو كود
        await handleDbSet(env, `promocodes/${promoId}`, newPromoCode);
        
        return {
            success: true,
            data: {
                promoCode: newPromoCode,
                promoId: promoId,
                message: 'Promo code created successfully'
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'CREATE_PROMO_CODE_ERROR'
        };
    }
}

async function handleGetLeaderboard(env) {
    try {
        const usersResult = await handleDbGet(env, 'users');
        const usersData = usersResult.data || {};
        
        const users = [];
        
        for (const [userId, userData] of Object.entries(usersData)) {
            // تخطي المستخدمين المحظورين من المتصدرين
            if (userData.isBlocked) continue;
            
            users.push({
                userId: userId,
                name: userData.name || 'Anonymous',
                photoUrl: userData.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png',
                dogsBalance: userData.dogsBalance || 0,
                referrals: userData.referrals || 0
            });
        }
        
        const byInvites = [...users].sort((a, b) => b.referrals - a.referrals);
        
        const byGLX = [...users].sort((a, b) => b.dogsBalance - a.dogsBalance);
        
        return {
            success: true,
            data: {
                byInvites: byInvites.slice(0, 50),
                byGLX: byGLX.slice(0, 50)
            }
        };
    } catch (error) {
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_LEADERBOARD_ERROR'
        };
    }
}

async function handleGetCompetitionData(env, userId = null) {
    try {
        // التحقق من الحظر إذا كان هناك معرف مستخدم
        if (userId) {
            const blockCheck = await checkUserBlocked(env, userId);
            if (blockCheck && blockCheck.isBlocked) {
                return { 
                    success: false, 
                    error: 'ACCOUNT_BLOCKED',
                    errorCode: 'ACCOUNT_BLOCKED',
                    data: { 
                        isBlocked: true,
                        blockDetails: blockCheck,
                        blockedMessage: `🚫 Account Blocked\n\nReason: ${blockCheck.reason}\nViolation: ${blockCheck.violation}\n\nThis decision is final.`,
                        redirectToBlockPage: true
                    }
                };
            }
        }
        
        // أولاً: ضمان وجود مسابقة نشطة
        const competitionData = await ensureAndGetCompetition(env, userId);
        
        if (!competitionData) {
            return {
                success: false,
                error: 'Failed to load competition data',
                errorCode: 'COMPETITION_DATA_LOAD_ERROR'
            };
        }
        
        // جلب المتصدرين
        const userTickets = competitionData.userTickets || {};
        const leaderboard = [];
        
        for (const [uId, tickets] of Object.entries(userTickets)) {
            if (tickets > 0) {
                const userResult = await handleDbGet(env, `users/${uId}`);
                if (userResult.success && userResult.data) {
                    // تخطي المستخدمين المحظورين من المتصدرين
                    if (userResult.data.isBlocked) continue;
                    
                    leaderboard.push({
                        userId: uId,
                        name: userResult.data.name || 'Anonymous',
                        photoUrl: userResult.data.photoUrl || 'https://i.ibb.co/tTkJX1Qy/logo.png',
                        tickets: tickets
                    });
                }
            }
        }
        
        leaderboard.sort((a, b) => b.tickets - a.tickets);
        
        return {
            success: true,
            data: {
                competitionData: {
                    isActive: competitionData.isActive,
                    startTime: competitionData.startTime,
                    endTime: competitionData.endTime,
                    totalTickets: competitionData.totalTickets || 0,
                    prizePool: competitionData.prizePool || 0,
                    timeRemaining: competitionData.timeRemaining,
                    timeRemainingFormatted: competitionData.timeRemainingFormatted,
                    isActiveNow: competitionData.isActiveNow
                },
                userTickets: userId ? competitionData.userTicketCount || 0 : 0,
                leaderboard: leaderboard.slice(0, 10)
            }
        };
    } catch (error) {
        console.error('Error getting competition data:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'GET_COMPETITION_DATA_ERROR'
        };
    }
}

// ==================== نهاية الكود ====================
