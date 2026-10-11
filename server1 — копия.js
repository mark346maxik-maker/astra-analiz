const express = require('express');
const path = require('path');
const fs = require('fs');
const { Origin, Horoscope } = require('circular-natal-horoscope-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const API_KEY = process.env.API_KEY || 'sk-BupGwWxdPav0VY1eIHwryfLQAnWgcVyZjacxxyok5mw16YyK5wyqPJyRCyOb';
const PROXY_URL = 'https://proxy.gen-api.ru/v1/chat/completions';
const MODEL_ID = 'gpt-4o-mini';

const SHOP_ID = '1481559';
const SECRET_KEY = 'live_x7W2GIU1meU052hZVmDUgXRntyUHyuAtfD8VhTf9AUA';

const DB_FILE = fs.existsSync('/data') ? '/data/subscriptions.json' : path.join(__dirname, 'subscriptions.json');

// Надежная загрузка с автоматическим созданием файла, если его нет
function loadSubscriptions() {
    if (!fs.existsSync(DB_FILE)) {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2));
        } catch (e) {
            console.error('Не удалось создать subscriptions.json', e);
        }
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
        return {};
    }
}

function saveSubscriptions(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Middleware: строгая проверка подписки и актуального пароля
function checkSubscription(req, res, next) {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html' || req.path.endsWith('.css') || req.path.endsWith('.js'))) {
        return next();
    }

    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const isBot = /whatsapp|telegrambot|vkshare|facebot|facebookexternalhit|twitterbot|viber/i.test(userAgent);
    
    if (isBot) {
        return next();
    }

    const clientId = req.headers['x-client-id'] || req.query.clientId || req.query.client_id || req.body.clientId;
    const accessKey = req.headers['x-access-key'];

    const subs = loadSubscriptions();

    // 1. Проверяем по переданному паролю
    if (accessKey) {
        let keyMatched = false;
        let isExpired = true;

        for (const cid in subs) {
            if ((subs[cid].accessKey || '').toString().trim() === accessKey.trim()) {
                keyMatched = true;
                if (subs[cid].expiresAt && new Date(subs[cid].expiresAt) > new Date()) {
                    isExpired = false;
                    break;
                }
            }
        }

        if (keyMatched && !isExpired) {
            return next();
        }
    }

    // 2. Проверка по ID клиента
    if (clientId && subs[clientId]) {
        const userSub = subs[clientId];
        if (userSub.expiresAt && new Date(userSub.expiresAt) > new Date()) {
            if (accessKey && accessKey.trim() !== userSub.accessKey) {
                return res.status(403).json({ error: 'Пароль был изменен. Сеанс завершен.' });
            }
            return next();
        }
    }

    return res.status(403).json({ error: 'Требуется активная подписка для выполнения расчета.' });
}

// Эндпоинт проверки платежа
app.get('/api/verify-payment', async (req, res) => {
    try {
        const paymentId = req.query.paymentId;
        const queryClientId = req.query.clientId || req.query.client_id;
        const customPassword = req.query.password;

        if (!paymentId) {
            return res.status(400).json({ error: 'Нет данных платежа' });
        }

        const response = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')
            }
        });

        const payment = await response.json();
        
        if (response.ok && payment.status === 'succeeded') {
            const targetClientId = payment.metadata?.clientId || queryClientId;
            const paymentPlan = payment.metadata?.plan || 'month';
            const paymentPassword = payment.metadata?.password || customPassword;

            if (!targetClientId) {
                return res.status(400).json({ error: 'Не удалось определить ID клиента для подписки' });
            }

            const subs = loadSubscriptions();
            const currentExpiry = new Date();

            if (paymentPlan === 'day') {
                currentExpiry.setDate(currentExpiry.getDate() + 1);
            } else {
                currentExpiry.setDate(currentExpiry.getDate() + 30);
            }

            let accessKey = paymentPassword ? paymentPassword.trim() : subs[targetClientId]?.accessKey;
            if (!accessKey) {
                accessKey = 'astra_' + Math.random().toString(36).substring(2, 10);
            }

            subs[targetClientId] = {
                expiresAt: currentExpiry.toISOString(),
                paymentId: payment.id,
                plan: paymentPlan,
                accessKey: accessKey
            };

            saveSubscriptions(subs);
            console.log(`✅ Подписка (${paymentPlan}) привязана к устройству: ${targetClientId}, Пароль: ${accessKey}`);
            
            return res.json({ success: true, clientId: targetClientId, accessKey: accessKey });
        }

        console.log(`⏳ Платеж еще не подтвержден. Статус: ${payment.status}`);
        res.json({ success: false, status: payment.status });
    } catch (e) {
        console.error('Verify payment error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Эндпоинт установки или смены пароля
app.post('/api/set-password', (req, res) => {
    const { clientId, accessKey, newPassword } = req.body;
    if (!newPassword || newPassword.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'Не указан новый пароль.' });
    }

    const subs = loadSubscriptions();
    let targetCid = null;

    if (clientId && subs[clientId]) {
        targetCid = clientId;
    } else if (accessKey) {
        for (const cid in subs) {
            if ((subs[cid].accessKey || '').toString().trim() === accessKey.trim()) {
                targetCid = cid;
                break;
            }
        }
    }

    if (!targetCid && clientId) {
        targetCid = clientId;
        if (!subs[targetCid]) {
            subs[targetCid] = {};
        }
    }

    if (!targetCid || !subs[targetCid] || !subs[targetCid].expiresAt || new Date(subs[targetCid].expiresAt) <= new Date()) {
        return res.status(404).json({ success: false, message: 'Активная подписка не найдена. Сначала оформите доступ.' });
    }

    const trimmedNewPass = newPassword.trim();
    subs[targetCid].accessKey = trimmedNewPass;

    saveSubscriptions(subs);
    console.log(`🔒 Пароль успешно изменен для клиента ${targetCid}`);

    res.json({ success: true, message: 'Пароль успешно обновлен!' });
});

// Эндпоинт входа по секретному паролю с другого устройства
app.post('/api/login-by-key', (req, res) => {
    const { accessKey, clientId } = req.body;
    if (!accessKey) {
        return res.status(400).json({ success: false, message: 'Не указан пароль.' });
    }

    const subs = loadSubscriptions();
    let foundCid = null;
    let foundSub = null;
    const cleanInputKey = accessKey.trim();

    for (const cid in subs) {
        const storedKey = (subs[cid].accessKey || '').toString().trim();
        if (storedKey === cleanInputKey) {
            foundCid = cid;
            foundSub = subs[cid];
            break;
        }
    }

    if (!foundSub || !foundSub.expiresAt || new Date(foundSub.expiresAt) <= new Date()) {
        return res.status(404).json({ success: false, message: 'Пароль не найден или срок действия подписки истек.' });
    }

    let targetClientId = foundCid;
    if (clientId && clientId !== foundCid) {
        subs[clientId] = {
            expiresAt: foundSub.expiresAt,
            paymentId: foundSub.paymentId,
            plan: foundSub.plan,
            accessKey: foundSub.accessKey
        };
        targetClientId = clientId;
        saveSubscriptions(subs);
    }

    // Возвращаем clientId клиенту, чтобы устройство синхронизировалось
    res.json({ success: true, clientId: targetClientId, message: 'Успешный вход по паролю!' });
});

// Эндпоинт для проверки статуса подписки фронтендом
app.get('/api/check-status', (req, res) => {
    const clientId = req.headers['x-client-id'] || req.query.clientId || req.query.client_id;
    const accessKey = req.headers['x-access-key'];

    const subs = loadSubscriptions();

    if (accessKey) {
        for (const cid in subs) {
            if ((subs[cid].accessKey || '').toString().trim() === accessKey.trim() && subs[cid].expiresAt && new Date(subs[cid].expiresAt) > new Date()) {
                return res.json({ active: true, expiresAt: subs[cid].expiresAt, plan: subs[cid].plan });
            }
        }
    }

    if (clientId && subs[clientId]) {
        const userSub = subs[clientId];
        if (userSub.expiresAt && new Date(userSub.expiresAt) > new Date()) {
            if (accessKey && accessKey.trim() !== (userSub.accessKey || '').toString().trim()) {
                return res.json({ active: false });
            }
            return res.json({ active: true, expiresAt: userSub.expiresAt, plan: userSub.plan });
        }
    }

    return res.json({ active: false });
});

function loadLocalKnowledge() {
    const dirPath = path.join(__dirname, 'text');
    let knowledgeBase = '';

    if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        files.forEach(file => {
            const lowerFile = file.toLowerCase();
            if (lowerFile.endsWith('.txt') || lowerFile.endsWith('.json') || lowerFile.endsWith('.md')) {
                const filePath = path.join(dirPath, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                knowledgeBase += `\n--- ФАЙЛ: ${file} ---\n${content}\n`;
            }
        });
    }

    knowledgeBase += `
--- ВСТРОЕННАЯ БАЗА ЗНАНИЙ (ASTRO DATA) ---

aspect_0.txt:
общая характеристика . совместные действия.

aspect_60.txt:
возможности которые даются при активном действии. нужно приложить усилия.

aspect_90.txt:
Выполнения условий характеристик планет знаков и домов, иначе появляется напряжение и недовольство. Напряжённая ситуация. Конфликт. Раздражение.

aspect_120.txt:
Всё получается. Гармония во всём. События хорошо развиваются. Везение. Понимание друг друга во всём.

aspect_150.txt:
Разные события, нужно делать то, что не входит в планы по планетам, знакам и домам.

aspect_180.txt:
Нужно успевать делать по обеим планетам, компромис. Выбор по планетам, знакам и домам..

house_1.txt:
Связан с личными действиями человека. Выражением себя, ставя себя на первое место. Активность. Инициатива. Самореализация. Темперамент. Способность.

house_2.txt:
Материальное благосостояние. Имущество. Накопления. Собственный доход. Траты, покупки,личные ресурсы. Таланты,учения. Своё дело.

house_3.txt:
Контакты. Коммуникации. Телефонные общения,Спрашиивать, Курсы ,учёба. Интелект.  Короткие поездки транспортом. Автомобили. Разговоры, обсуждение.

house_4.txt:
 Своё дело, частный бызнес, Недвижимость. находиться дома, Родственники, Семья, родители, материнство, Зачатие, Дом, земельный участок, Земля, своё хозяйство.

house_5.txt:
Лидерство. Любовь. Слава. Успех. Творчество. Дети, игры, развлечения. Эротика. Выразить себя.

house_6.txt:
Работа. Долг. Служба. Повседневные обязаности. Помогать, помощь, лечение, диета. Здоровье.

house_7.txt:
Супружество. Брак. Поведение в паре. Другой человек. Договора. Партнёрство. Суды. 

house_8.txt:
Доходы. Ресурсы. Деньги других людей. Страховки. Финансы. Бизнесмен. Смерть. Секс. экстрим. Страсть. Желания. Хотеть.

house_9.txt:
Знания. Наука. Образование. Обучать, Препадовать. Издательство. Путешествие. Заграница. Поездки. Иностранцы. Другая иностранная культура.

house_10.txt:
Власть. Карьера. Администрация. Репутация. Начальники. Высшая инстанция. Профессианальный рост. Структура.Строить планы.

house_11.txt:
Друзья. Группы. Люди. Общественная деятельность. Коллектив. Активная социальная жизнь.

house_12.txt:
Духовная сфера. Вера. Религия. Тайное. Закрытые оргонизации.Одиночество. Изоляция. Спрятаться.

planet_венера.txt:
Личные финансы. Накопления. Траты на покупки. Удавольствия. Видение красивого. Нравиться. Не наравиться, Красота, искусство, Любовь , Внешний вид, Одежда, Деньги, траты, Финансы, Ценности, Покупки, Подарки, Еда, Вкусы, Кулинария,Удовольствия, кайф, Форма тела, Женское начало, Парфюм, косметика, Люблю , не люблю,Нравится ,  не нравится, Творчество, дизайн, Сфера красоты, интерьер

planet_луна.txt:
Чувствительность. Беспокойства. Житейские потребности. Территория. Недвижимость. Земельный участок.  Душа, душевное состояние. Эмоциональный мир,Чувства, любовь,  домашний, Подсознание,Переживания, Эмпатия,Мать, жена, хозяйка,душевная радость.

planet_марс.txt:
Сила. Воля. Арессивность. Активность. Делать , Быстро делать. Скорость. Действие, Физические действия, Энергия, Энергетика, Начало, Спорт, Соревнования, Агрессия, Бой, Конфликт, Вражда, Риск, нападение.

planet_меркурий.txt:
Интелектуальная активность. Спрашивать. Интересоваться. Автомобили. читать. курсы. Документы. Социальные сети. Интернет, Разговор, рассказ, Голос, тембр, стиль, пение, Мыслительные процессы, Способность к обучению, Способ передачи информации, Литературные способности,Выбор, Поездки, Торговля, Средства связи, Транспорт, Издательство, Книги, Печать, Аналитика, Анализ

planet_нептун.txt:
Ресурсы, Чужие деньги, Желания, Тайны, Искушения, Страсти, Стремления, Обман, Кража, Финансовые махинации, Траты, Злоупотребления,наркомания, пьянство, игромания, гулянки, Психика, Нетрадиционная медицина, Экспертиза.

planet_плутон.txt:
Сотрудничество. обвинять, Союз. Судебные споры. Другой человек. Партнёр. Конфликты, Действия вдвоём, Отношения один на один, Союз, Вместе, Дружба. Споры, Суды, Договор, Вражда, обвинять.

planet_сатурн.txt:
Работа. Планирование. Организация. Государственная структура. Ограничение. Дела. Структура, План, Система, Законы, Правила, Порядки, Управление, Чиновники, Государственные структуры, Нельзя,  Надлежащее, Расписание, Ответственность, Результаты, Сужение возможностей.

planet_солнце.txt:
Успех. Сознательность. Личность. Показать себя. Важность. Авторитетность. Слава, Личность, Центр внимания, Лидерские качества, Мужская роль, Отец, муж, Самореализация, Проявление себя.

planet_уран.txt:
Резкие изменения. Переезды. Поехать далеко. Компьютерные разработки. Полёты. Экспертность. Обучать. Перемена. Электричество. Технологии. Изобретения. Разработки, Независимо, Разрушает, Разрывает, Уходы, Разводы,Резкие переезды, поездки, Новые технологии, Новинки, изобретения, Прозрения. Кричать. Крик. Повышение голоса.

planet_юпитер.txt:
Люди. Друзья. Компания. Коллектив. Социум. Общество, Отношение к людям, Поведение в коллективе. Наблюдать. Видеть. Несколько человек.

sign_Близнецы.txt:
суетливый,общительный. Информационный.постоянно ищет информацию. учеба, интерес, знакомство, вопрос, коммуникации, транспорт, изменение, перемещение, понимание, новизна, связь, разговор, общение, беседа, прогулка, поиск, информация, инфраструктура.

sign_Весы.txt:
Быть в двоём, равновесие. Партнёрство. супружество, партнерство, пара, союз, совместное, отношения, согласие, соответствие, договор, взаимность, вдвоем, равновесие, баланс, сочетание, ориентирование на другого, обращение к другому.

sign_Водолей.txt:
Любит находиться среди общества. наблюдает. наблюдения, внимание, видение, будущее, космос, другие планеты, дружба, коллектив, социум, компания, группа, люди, справедливость, человечность, свобода, независимость, права человека, равенство.

sign_Дева.txt:
Помагать, Помощь, Занимается наукой. Точность. Работает много. Мелочный. Постоянно анализирует.Отвлекается на мелкие делали. здоровье, труд, работа, обязанности, чистота, коррекция, ремонт, исправление, критика, упорядочивание, проверка, уточнение, детализация, структурирование, перфекционизм, мастерство, инструменты, мелочи, микроскопическое, механизмы, медицина, учет, дозировка, лекарства, лечение, выполнение, полезное.

sign_Козерог.txt:
Деловой. Последовательный. Серьёзный. Главное работа. Карьерный рост. Административный. Любит, когда всё структуризировано. управление, контроль, порядок, правота, результат, итог, цель, решение, последовательность, правило, команда, задача, серьезность, деловитость, делегирование, начальство, рост, показатели, отчетность, завершение, проект, запрет.

sign_Лев.txt:
Яркий. Гордый. Хвастливый. Лидер. Театральный. Любит быть в центе внимания. При встречах берёт инициативу в свои руки. Любит блеск, яркое. демонстрация, показ, образ, доминирование, власть, лидерство, пример, игра, азарт, энергия, выступления, творчество, актерское мастерство, проявление себя, крутизна, величие, смелость, храбрость, гордость.

sign_Овен.txt:
Вспыльчивый. Быстрый. Воинственный. Энергичный. Любит спорт. Старается всё делать быстро. старт, начало, победа, действие, рывок, дерзость, соревнование, спорт, битва, война, сражение, состязание, единоборства, бой, удар, прием, оружие, драка, воля, первенство, энтузиазм, идея, новаторство, создание, творение, здесь и сейчас, прямо сейчас, настоящее время.

sign_Рак.txt:
Домашний. Семейный. Тихий. Скрытный. Любит уют дома. Нравится заботиться о родных. родство, сближение, родственники, семья, жилье, дом, пространство, память, прошлое, родина, национальность, патриотизм, безопасность, забота, опека, дети, воспитание, традиция, сельское хозяйство, домашнее хозяйство, чувства, эмоции, переживания, живое, ухаживание, бережливость, природа.

sign_Рыбы.txt:
Тайный. Молчиливый. Мистичный. Религиозный. Секретный. Тихий, Сам себе на уме. Умеет видеть общую картину. Мелочность не воспринимает. вера, восприятие, воображение, жалобы, жалость, жертвенность, просьбы, сострадание, любовь, духовность, нефизический мир, высшее, бог, психология, психологическая помощь, единство.

sign_Скорпион.txt:
Чужие ресурсы, займы, кредиты, долги, банкротство, потребление, иногда занимается трейдингом, финансы,  привлечение, доход, сильные желания, хотение, страсть, скрытое, внутреннее, тайное, сила, чутье, бывае предчувствие, мания, большие жизненные силы, секс, смерть. потребление, поглощение, глубина, чужие ресурсы, банки, займы, кредиты, долги, банкротство, трейдинг, финансы, прибыль, продажи, получение, привлечение, доход, желание, хотение, страсть, скрытое, внутреннее, тайное, сила, могущество, чутье, предчувствие, тяга, мания, жизненные силы, секс, смерть.

sign_Стрелец.txt:
Любит путешествие. Нравится море. Заграничная культура. Часто имеет глубокие знания. Любит учить. Препадовательская способность. Иногда тренерство. ответ, объяснение, наставление, тренерство, рассказ, история, поучение, притча, философия, эзотерика, знание, передача опыта, другие культуры, народы, иностранное, другие страны, поход, путешествие, движение, крупные животные.

sign_Телец.txt:
накопление, питание, еда, вкус, комфорт, владение, собственность, материальные ресурсы, Важно, чтобы был комфорт.Медлительность. Долго думает. накопление, питание, еда, вкус, комфорт, владение, собственность, материальные ресурсы, умение, имение, наслаждение, улыбка, оформление, форма, упаковка, красота, украшение, внешность, фигура, ценность, качество, внешний вид, одежда, стиль, тон, цвет, удобство, надежность, стойкость, упорство.
`;

    return knowledgeBase;
}

const ALLOWED_BODIES = [
    'sun', 'moon', 'mercury', 'venus', 'mars', 
    'jupiter', 'saturn', 'uranus', 'neptune', 'pluto',
    'erik', 'erida', 'eris', 'ceres'
];

const BODY_NAMES = {
    'sun': 'солнце ☀', 'moon': 'луна 🌙', 'mercury': 'меркурий ☿',
    'venus': 'венера ♀', 'mars': 'марс ♂', 'jupiter': 'юпитер ♃',
    'saturn': 'сатурн ♄', 'uranus': 'уран ♅', 'neptune': 'нептун ♆',
    'pluto': 'плутон ♇', 'eris': 'эрида 🪐', 'erida': 'эрида 🪐',
    'erik': 'эрида 🪐', 'ceres': 'церера 🌾'
};

const ZODIAC_NAMES = {
    'aries': 'Овен ♈', 'taurus': 'Телец ♉', 'gemini': 'Близнецы ♊',
    'cancer': 'Рак ♋', 'leo': 'Лев ♌', 'virgo': 'Дева ♍',
    'libra': 'Весы ♎', 'scorpio': 'Скорпион ♏', 'sagittarius': 'Стрелец ♐',
    'capricorn': 'Козерог ♑', 'aquarius': 'Водолей ♒', 'pisces': 'Рыбы ♓'
};

const ASPECT_TYPES = [
    { name: 'Соединение', angle: 0, emoji: '☌' },
    { name: 'Секстиль', angle: 60, emoji: '⚹' },
    { name: 'Квадратура', angle: 90, emoji: '□' },
    { name: 'Тригон', angle: 120, emoji: '△' },
    { name: 'Квиконс', angle: 150, emoji: '⚻' },
    { name: 'Оппозиция', angle: 180, emoji: '☍' }
];

function formatInSignDegrees(decimalDegrees) {
    const degInSign = decimalDegrees % 30;
    const deg = Math.floor(degInSign);
    const min = Math.round((degInSign - deg) * 60);
    return `${deg}°${min.toString().padStart(2, '0')}'`;
}

function getZodiacName(signObj) {
    if (!signObj) return '—';
    const rawKey = (signObj.key || signObj.name || '').toLowerCase();
    return ZODIAC_NAMES[rawKey] || signObj.key || '—';
}

function calculateAspects(h1, h2, maxOrbis) {
    const aspects = [];
    
    const getBodiesArray = (horoscope) => {
        if (!horoscope) return [];
        if (typeof horoscope.getCelestialBodies === 'function') {
            const bodies = horoscope.getCelestialBodies();
            if (Array.isArray(bodies)) return bodies;
        }
        if (horoscope.CelestialBodies) {
            if (Array.isArray(horoscope.CelestialBodies.all)) return horoscope.CelestialBodies.all;
            if (Array.isArray(horoscope.CelestialBodies)) return horoscope.CelestialBodies;
            return Object.values(horoscope.CelestialBodies);
        }
        return [];
    };

    const p1Bodies = getBodiesArray(h1);
    const p2Bodies = getBodiesArray(h2);

    const filteredP1 = p1Bodies.filter(b => b && (b.key || b.name) && ALLOWED_BODIES.includes((b.key || b.name).toLowerCase()));
    const filteredP2 = p2Bodies.filter(b => b && (b.key || b.name) && ALLOWED_BODIES.includes((b.key || b.name).toLowerCase()));

    filteredP1.forEach(b1 => {
        filteredP2.forEach(b2 => {
            const getDeg = (body) => {
                if (body.ChartPosition?.Ecliptic?.DecimalDegrees !== undefined) return body.ChartPosition.Ecliptic.DecimalDegrees;
                if (body.degree !== undefined) return body.degree;
                return undefined;
            };

            const deg1 = getDeg(b1);
            const deg2 = getDeg(b2);
            if (deg1 === undefined || deg2 === undefined) return;

            let diff = Math.abs(deg1 - deg2);
            if (diff > 180) diff = 360 - diff;

            for (const asp of ASPECT_TYPES) {
                const orb = Math.abs(diff - asp.angle);
                const effectiveOrbis = maxOrbis === 0 ? 0.008 : maxOrbis;

                if (orb <= effectiveOrbis) {
                    const k1 = (b1.key || b1.name).toLowerCase();
                    const k2 = (b2.key || b2.name).toLowerCase();
                    const z1 = getZodiacName(b1.Sign || b1.sign);
                    const z2 = getZodiacName(b2.Sign || b2.sign);
                    const hNum1 = b1.House?.id || b1.house || '—';
                    const hNum2 = b2.House?.id || b2.house || '—';

                    aspects.push(
                        `Ситуация — ${BODY_NAMES[k2] || k2} — ${formatInSignDegrees(deg2)} — ${z2} — Я — ${BODY_NAMES[k1] || k1} — ${formatInSignDegrees(deg1)} — ${z1} — ${hNum1} дом ${asp.emoji} ${asp.name} [орбис ${orb.toFixed(1)}°]`                    
                    );
                }
            }
        });
    });
    return aspects;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Создание платежа
app.get('/create-payment', async (req, res) => {
    try {
        const clientId = req.query.clientId || req.query.client_id || 'default_user';
        const plan = req.query.plan || 'month';
        const customPassword = req.query.password || '';
        const idempotenceKey = 'idempotence_' + Date.now() + Math.random();

        let amountValue = '900.00';
        let description = 'Подписка на сервис  на 30 дней (900 руб)';

        if (plan === 'day') {
            amountValue = '99.00';
            description = 'Тестовый доступ на 1 сутки (99 руб)';
        }

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const returnUrl = `${protocol}://${host}/?client_id=${clientId}`;

        const response = await fetch('https://api.yookassa.ru/v3/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotence-Key': idempotenceKey,
                'Authorization': 'Basic ' + Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')
            },
            body: JSON.stringify({
                amount: { value: amountValue, currency: 'RUB' },
                confirmation: {
                    type: 'redirect',
                    return_url: returnUrl
                },
                capture: true,
                description: description,
                metadata: { clientId, plan, password: customPassword }
            })
        });

        const payment = await response.json();
        if (!response.ok) throw new Error(payment.description || 'Ошибка платежа');

        res.redirect(`${payment.confirmation.confirmation_url}&payment_id=${payment.id}`);
    } catch (error) {
        console.error('YooKassa error:', error);
        res.status(500).send('Ошибка при создании платежа.');
    }
});

// Вебхук от ЮKassa
app.post('/api/webhook', async (req, res) => {
    try {
        const event = req.body;
        if (event.event === 'payment.succeeded') {
            const payment = event.object;
            const clientId = payment.metadata?.clientId;
            const paymentPlan = payment.metadata?.plan || 'month';
            const paymentPassword = payment.metadata?.password;
            
            if (clientId) {
                const subs = loadSubscriptions();
                const currentExpiry = new Date();

                if (paymentPlan === 'day') {
                    currentExpiry.setDate(currentExpiry.getDate() + 1);
                } else {
                    currentExpiry.setDate(currentExpiry.getDate() + 30);
                }

                let accessKey = paymentPassword ? paymentPassword.trim() : subs[clientId]?.accessKey;
                if (!accessKey) {
                    accessKey = 'astra_' + Math.random().toString(36).substring(2, 10);
                }

                subs[clientId] = { 
                    expiresAt: currentExpiry.toISOString(), 
                    paymentId: payment.id, 
                    plan: paymentPlan,
                    accessKey: accessKey
                };
                saveSubscriptions(subs);
                console.log(`🔔 Вебхук: подписка (${paymentPlan}) активирована для устройства ${clientId}`);
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Webhook error:', e);
        res.sendStatus(500);
    }
});

app.post('/api/calculate', checkSubscription, (req, res) => {
    try {
        const { p1Date, p1Time, p1Place, p2Date, p2Time, p2Place, orbis } = req.body;
        const maxOrbis = (orbis !== undefined && orbis !== '') ? parseFloat(orbis) : 6;
        if (!p1Date || !p2Date) return res.status(400).json({ error: 'Не указаны даты.' });

        const [p1Y, p1M, p1D] = p1Date.split('-').map(Number);
        const [p1H, p1Min] = (p1Time || '12:00').split(':').map(Number);
        const [p2Y, p2M, p2D] = p2Date.split('-').map(Number);
        const [p2H, p2Min] = (p2Time || '12:00').split(':').map(Number);

        const h1 = new Horoscope({ origin: new Origin({ year: p1Y, month: p1M - 1, date: p1D, hour: p1H, minute: p1Min, latitude: 55.75, longitude: 37.61 }) });
        const h2 = new Horoscope({ origin: new Origin({ year: p2Y, month: p2M - 1, date: p2D, hour: p2H, minute: p2Min, latitude: 55.75, longitude: 37.61 }) });

        res.json({ aspects: calculateAspects(h1, h2, maxOrbis) });
    } catch (err) {
        console.error('Calculation error:', err);
        res.status(500).json({ error: 'Ошибка расчета.' });
    }
});

app.post('/api/generate-ai', checkSubscription, async (req, res) => {
    try {
        const { selectedAspect, allAspects, question } = req.body;
        let localKnowledge = loadLocalKnowledge();
        
        if (!localKnowledge) {
            return res.json({ text: "Ошибка: База знаний пуста!" });
        }

        if (localKnowledge.length > 15000) localKnowledge = localKnowledge.substring(0, 15000);

        const systemInstruction = `ТЫ — строгий астрологический интерпретатор-робот.

СТРОГИЕ ПРАВИЛА ВЫВОДА ТЕКСТА:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО перечислять входные данные (не пиши названия планет, знаки, градусы, номера домов, орбисы и типы аспектов вроде "Соединение тригон луна солнце в 4 доме"). Сразу выдавай готовую суть и интерпретацию!
2. Учитывай дома исключительно из части "Я" (мои дома). Дома, относящиеся к ситуации, игнорируй.
3. Используй ИСКЛЮЧИТЕЛЬНО те ключевые слова и смыслы, которые написаны в предоставленной базе знаний выше для конкретной планеты , знака, моего дома или аспекта. 
4.КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО добавлять любые астрологические слова, значения, трактовки, ассоциации или слова из своих базовых знаний (интернета), если их нет в тексте базы данных. 
5.Соединяй ключевые слова и суммируй их в предложения. ОТВЕЧАЙ полноценно и четко и по делу, что ожидать в этот день и посоветуй как себя вести, как на меня действуют аспекты ситуации.
6.Если в описании Плутона нет слова трансформация, и у Нептуна нет слова "иллюзии" — значит, для этого расчета трансформаций и иллюзий не существует, используй только то, что перечислено (деньги, ресурсы, желания и т.д.).`;
        let userPrompt = '';
        if (selectedAspect === 'GENERAL_ANALYSIS') {
            const aspectsListStr = Array.isArray(allAspects) ? allAspects.join('\n') : JSON.stringify(allAspects);
            userPrompt = `База знаний:\n${localKnowledge}\n\nСделай общий анализ всех выпавших аспектов. Выдай сразу единый связный текст-характеристику и рекомендации без перечисления самих аспектов и планет.\nСписок аспектов:\n${aspectsListStr}\n${question ? `Вопрос: "${question}"` : ''}`;
        } else {
            userPrompt = `База знаний:\n${localKnowledge}\n\nАспект для анализа: "${selectedAspect}"\n${question ? `Вопрос: "${question}"` : ''}\n\nВыдай сразу готовую интерпретацию и советы без пересказа исходного аспекта.`;
        }

        const response = await fetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
            body: JSON.stringify({
                model: MODEL_ID,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.2,
                max_tokens: 3500
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Ошибка API');

        res.json({ text: data.choices?.[0]?.message?.content || 'Нет ответа' });
    } catch (error) {
        res.status(500).json({ error: `Ошибка ИИ: ${error.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));