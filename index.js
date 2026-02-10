
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const nodemailer = require('nodemailer')
const { Client } = require('basic-ftp')
const xml2js = require('xml2js')
const fs = require('fs')
const path = require('path')
const moment = require('moment-timezone')

const app = express()
const prisma = new PrismaClient()
const PORT = process.env.PORT || 3002 // Cemre Port

// Middleware
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// --- FILE WATCHER FOR ERP INTEGRATION ---
const WATCH_DIR = path.join(__dirname, 'ftp-data');
const WATCH_FILE = 'q-ctrl.json';
const FULL_WATCH_PATH = path.join(WATCH_DIR, WATCH_FILE);

// Ensure watching directory exists
if (!fs.existsSync(WATCH_DIR)) {
    fs.mkdirSync(WATCH_DIR);
}

console.log(`Watching for ERP data at: ${FULL_WATCH_PATH}`);

// Debounce to prevent multiple rapid triggers
let processingLock = false;

// Function to process the JSON file
const processErpFile = async () => {
    // Prevent overlapping executions
    if (processingLock) {
        console.log('Zaten işleniyor, atlanıyor...');
        return;
    }
    processingLock = true;

    console.log('ERP dosya değişikliği algılandı. İşleniyor...');

    // Wait a brief moment to ensure file write is complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!fs.existsSync(FULL_WATCH_PATH)) {
        processingLock = false;
        return;
    }

    try {
        const rawData = fs.readFileSync(FULL_WATCH_PATH, 'utf-8');
        const data = JSON.parse(rawData);
        const orders = data.wtemp;

        if (!Array.isArray(orders)) {
            console.error('ERP Dosya Formatı Hatalı: wtemp dizisi bulunamadı.');
            processingLock = false;
            return;
        }

        console.log(`Bulunan Sipariş Sayısı: ${orders.length}. Veritabanı güncelleniyor...`);

        let newCount = 0;
        let updateCount = 0;
        for (const order of orders) {
            const orderData = {
                firma: order.firma,
                musadi: order.musadi,
                mail: order.mail,
                tarih: order.tarih,
                urunadi: order.urunadi,
                out: order.out,
                stkno: order.stkno ? String(order.stkno) : null,
                sevktar: order.sevktar,
                mik: order.mik,
                modul: order.modul,
                kumas: order.kumas,
                acik: order.acik,
                ayak: order.ayak,
                kirlent: order.kirlent,
                tip: order.tip,
            };

            // First check if it exists (for diff check to avoid unnecessary updatedAt changes)
            const exists = await prisma.order.findUnique({
                where: {
                    sipno_sipsr: {
                        sipno: order.sipno,
                        sipsr: order.sipsr,
                    }
                }
            });

            if (!exists) {
                // Use upsert to safely handle race conditions
                await prisma.order.upsert({
                    where: {
                        sipno_sipsr: {
                            sipno: order.sipno,
                            sipsr: order.sipsr,
                        }
                    },
                    create: {
                        sipno: order.sipno,
                        sipsr: order.sipsr,
                        ...orderData,
                    },
                    update: {} // If it was already created by a parallel run, do nothing
                });
                newCount++;
            } else {
                // Check if data actually changed to avoid unnecessary updates/timestamp refreshes
                const isDifferent =
                    exists.firma !== order.firma ||
                    exists.musadi !== order.musadi ||
                    exists.mail !== order.mail ||
                    exists.tarih !== order.tarih ||
                    exists.urunadi !== order.urunadi ||
                    exists.out !== order.out ||
                    (exists.stkno !== (order.stkno ? String(order.stkno) : null)) ||
                    exists.sevktar !== order.sevktar ||
                    exists.mik !== order.mik ||
                    exists.modul !== order.modul ||
                    exists.kumas !== order.kumas ||
                    exists.acik !== order.acik ||
                    exists.ayak !== order.ayak ||
                    exists.kirlent !== order.kirlent ||
                    exists.tip !== order.tip;

                if (isDifferent) {
                    await prisma.order.update({
                        where: { id: exists.id },
                        data: orderData
                    });
                    updateCount++;
                    console.log(`Sipariş güncellendi: ${order.sipno}-${order.sipsr}`);
                }
            }
        }
        console.log(`Senkronizasyon Tamamlandı. ${newCount} yeni, ${updateCount} güncellenen sipariş.`);

    } catch (err) {
        console.error('ERP Dosya İşleme Hatası:', err);
    } finally {
        processingLock = false;
    }
};

// Initial check on startup
processErpFile();

// Watch for changes
fs.watch(WATCH_DIR, (eventType, filename) => {
    if (filename === WATCH_FILE) {
        processErpFile();
    }
});
// ----------------------------------------

// --- JWT AUTH MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn(`[AUTH] Reddedildi - Token yok. Path: ${req.path}`);
        return res.status(401).json({ error: 'Yetkilendirme gerekli' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'cemre_secret_key_2026_secured');
        req.user = decoded;
        next();
    } catch (err) {
        console.warn(`[AUTH] Reddedildi - Geçersiz token. Path: ${req.path}`);
        return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' });
    }
};
// --------------------------

// Auth Route
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body

    try {
        const user = await prisma.user.findUnique({
            where: { username }
        })

        if (!user) {
            return res.status(401).json({ error: 'Kullanıcı bulunamadı' })
        }

        const valid = await bcrypt.compare(password, user.password)
        if (!valid) {
            return res.status(401).json({ error: 'Şifre hatalı' })
        }

        // Generate generic JWT token
        const token = jwt.sign(
            { id: user.id, username: user.username },
            process.env.JWT_SECRET || 'cemre_secret_key_2026_secured',
            { expiresIn: '24h' }
        )

        res.json({
            success: true,
            user: { username: user.username },
            token
        })

    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Sunucu hatası' })
    }
})

// Orders Route (Protected)
app.get('/api/orders', authMiddleware, async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            orderBy: { tarih: 'desc' }
        })
        res.json(orders)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: 'Veri çekilemedi' })
    }
})

// Mail Send Route (Protected)
app.post('/api/mail/send', authMiddleware, async (req, res) => {
    console.log('Mail gönderme isteği aldı:', req.body.headerText);

    try {
        // 1. Prepare Attachments
        const attachments = []
        if (req.body.images && Array.isArray(req.body.images)) {
            for (let i = 0; i < req.body.images.length; i++) {
                const base64Data = req.body.images[i].split(';base64,').pop()
                attachments.push({
                    filename: `image_${Date.now()}_${i}.jpeg`,
                    content: base64Data,
                    encoding: 'base64'
                })
            }
        }

        // 2. Prepare Question/Answers HTML
        const questionAnswersHTML = req.body.questions.map(q => {
            return `<div style='display: flex; flex-direction: row; max-width: 400px; border-bottom: 1px solid #ccc;'>
                        <span style='width: 70%; padding: 10px; background-color: #f0f0f0; margin-top: 10px;'>${q.question}</span>
                        <span style='width: 30%; padding: 10px; margin-top: 10px; background-color: aquamarine; display: flex; align-items: center; justify-content: center;'>${q.fakeRes || "Evet"}</span>
                     </div>`
        }).join('')

        // 3. Prepare XML Data
        const xmlData = {
            questions: [],
            images: attachments.map(a => ({
                filename: a.filename,
                content: a.content,
                encoding: a.encoding
            })),
            musInfo: {
                ...req.body.params,
                creatime: moment().tz("Europe/Istanbul").format("DD-MM-YYYY"),
            }
        }

        const answerValues = Object.values(req.body.answers || {})
        for (let i = 0; i < req.body.questions.length; i++) {
            xmlData.questions.push({
                question: req.body.questions[i].question,
                answer: answerValues[i]
            })
        }

        // 4. Build XML & write locally
        const builder = new xml2js.Builder()
        const xml = builder.buildObject(xmlData)
        const xmlFilename = `${xmlData.musInfo.sipno}-${xmlData.musInfo.sipsr}.xml`
        const localXmlPath = path.join(__dirname, xmlFilename)
        fs.writeFileSync(localXmlPath, xml)

        // 5. Send Email FIRST (user waits for this)
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: parseInt(process.env.SMTP_PORT || '587') === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        })

        const customerMail = req.body.params?.mail;
        const testMail = process.env.TEST_MAIL_RECEIVER || "mikbalaygun@gmail.com";

        const receivers = [];
        if (customerMail && customerMail.includes('@')) {
            receivers.push(customerMail);
        } else {
            console.warn("Müşteri maili bulunamadı veya geçersiz. Test mailine gönderiliyor.");
            receivers.push(testMail);
        }

        console.log('Mail gönderiliyor:', receivers)

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: receivers,
            // Check if Cemre has a specific CC address, otherwise use same pattern
            cc: [testMail, 'kalitekontrol@seyrankoltuk.com.tr'],
            subject: req.body.headerText || "Cemre Koltuk Kalite Kontrol Raporu",
            html: `<!DOCTYPE html>
            <html lang="tr">
            <head>
                <meta charset="UTF-8" />
                <title>Cemre Koltuk</title>
            </head>
            <body>
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h3>${req.body.text || "Kalite kontrol işlemleri tamamlandı."}</h3>
                    <hr />
                    <h4>Kontrol Listesi:</h4>
                    ${questionAnswersHTML}
                </div>
            </body>
            </html>`,
            attachments: attachments
        })

        // 6. Update Order Status in DB
        const params = req.body.params || {};
        if (params.sipno && params.sipsr) {
            try {
                const sipno = Number(params.sipno);
                const sipsr = Number(params.sipsr);

                console.log(`DB Güncelleme Başlıyor: ${sipno}-${sipsr}`);

                const updatedOrder = await prisma.order.update({
                    where: {
                        sipno_sipsr: { sipno, sipsr }
                    },
                    data: {
                        mailSent: true,
                        mailSentAt: new Date()
                    }
                });
                console.log(`✅ Sipariş mail durumu güncellendi: ${updatedOrder.sipno}-${updatedOrder.sipsr}`);
            } catch (dbErr) {
                console.error('❌ Sipariş durumu güncellenemedi (Mail Sent Flag):', dbErr);
            }
        } else {
            console.warn('⚠️ Mail atıldı ama sipno/sipsr eksik, DB güncellenemedi:', params);
        }

        // 7. RESPOND IMMEDIATELY - User sees success here!
        res.json({ success: true, message: 'Mail gönderildi' })

            // 8. Upload FTP in BACKGROUND (user does NOT wait for this)
            ; (async () => {
                const client = new Client(60000) // 1 minute timeout
                client.ftp.verbose = true
                try {
                    await client.access({
                        host: process.env.FTP_HOST,
                        user: process.env.FTP_USER,
                        password: process.env.FTP_PASS,
                        secure: false
                    })
                    const remotePath = `/kalite-kontrol/${xmlFilename}`
                    await client.uploadFrom(localXmlPath, remotePath)
                    console.log('FTP yükleme tamamlandı (arka plan):', remotePath)
                } catch (ftpErr) {
                    console.error('FTP Error (arka plan):', ftpErr)
                } finally {
                    client.close()
                    if (fs.existsSync(localXmlPath)) fs.unlinkSync(localXmlPath)
                }
            })();

    } catch (error) {
        console.error('Process Error:', error)
        res.status(500).json({ error: 'İşlem sırasında hata oluştu: ' + error.message })
    }
})

app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running securely on http://127.0.0.1:${PORT}`)
})
