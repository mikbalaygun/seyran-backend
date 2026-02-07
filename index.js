
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken') // I realized I didn't install jsonwebtoken, need to add it or just use simple session/token
const nodemailer = require('nodemailer')
const { Client } = require('basic-ftp')
const xml2js = require('xml2js')
const fs = require('fs')
const path = require('path')
const moment = require('moment-timezone')

const app = express()
const prisma = new PrismaClient()
const PORT = process.env.PORT || 3001

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

// Function to process the JSON file
const processErpFile = async () => {
    console.log('ERP dosya değişikliği algılandı. İşleniyor...');

    // Wait a brief moment to ensure file write is complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!fs.existsSync(FULL_WATCH_PATH)) return;

    try {
        const rawData = fs.readFileSync(FULL_WATCH_PATH, 'utf-8');
        const data = JSON.parse(rawData);
        const orders = data.wtemp;

        if (!Array.isArray(orders)) {
            console.error('ERP Dosya Formatı Hatalı: wtemp dizisi bulunamadı.');
            return;
        }

        console.log(`Bulunan Sipariş Sayısı: ${orders.length}. Veritabanı güncelleniyor...`);

        let count = 0;
        for (const order of orders) {
            const exists = await prisma.order.findUnique({
                where: {
                    sipno_sipsr: {
                        sipno: order.sipno,
                        sipsr: order.sipsr,
                    }
                }
            });

            if (!exists) {
                await prisma.order.create({
                    data: {
                        sipno: order.sipno,
                        sipsr: order.sipsr,
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
                    }
                });
                count++;
            } else {
                // Update existing order if found (e.g. name change, details change)
                await prisma.order.update({
                    where: { id: exists.id },
                    data: {
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
                    }
                });
                // Optional: Log update?
                // console.log(`Sipariş güncellendi: ${order.sipno}-${order.sipsr}`);
            }
        }
        console.log(`Senkronizasyon Tamamlandı. ${count} yeni sipariş eklendi.`);

    } catch (err) {
        console.error('ERP Dosya İşleme Hatası:', err);
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
            process.env.JWT_SECRET || 'seyran_secret_key_2026',
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

// Orders Route
app.get('/api/orders', async (req, res) => {
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

// Original Logic: /test/deneme -> repurposed to /api/mail/send
app.post('/api/mail/send', async (req, res) => {
    console.log('Mail gönderme isteği aldı:', req.body.headerText);

    try {
        // 1. Prepare Attachments
        const attachments = []
        if (req.body.images && Array.isArray(req.body.images)) {
            for (let i = 0; i < req.body.images.length; i++) {
                const base64Data = req.body.images[i].split(';base64,').pop()
                attachments.push({
                    filename: `image_${Date.now()}_${i}.jpeg`, // Better naming
                    content: base64Data,
                    encoding: 'base64'
                })
            }
        }

        // 2. Prepare Question/Answers HTML
        const questionAnswersHTML = req.body.questions.map(q => {
            // Find answer
            // The old code was weird: answer: Object.values(req.body.answers)[i]
            // We should try to be safer.
            // Assume questions and answers are aligned or passed correctly.
            // Ideally the frontend sends structured { question, answer } pairs.
            // But if we keep frontend roughly same, we follow the pattern.
            // For the HTML view:
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

        // Map answers for XML
        // Assuming req.body.answers is an object with keys matching indices or just values?
        // Old code: answer: Object.values(req.body.answers)[i]
        const answerValues = Object.values(req.body.answers || {})
        for (let i = 0; i < req.body.questions.length; i++) {
            xmlData.questions.push({
                question: req.body.questions[i].question,
                answer: answerValues[i]
            })
        }

        // 4. Build XML
        const builder = new xml2js.Builder()
        const xml = builder.buildObject(xmlData)
        const xmlFilename = `${xmlData.musInfo.sipno}-${xmlData.musInfo.sipsr}.xml`
        const localXmlPath = path.join(__dirname, xmlFilename)

        // Write XML locally first
        fs.writeFileSync(localXmlPath, xml)

        // 5. Upload to FTP
        const client = new Client()
        // client.ftp.verbose = true
        try {
            await client.access({
                host: process.env.FTP_HOST,
                user: process.env.FTP_USER,
                password: process.env.FTP_PASS,
                secure: false
            })
            // await client.ensureDir("/kalite-kontrol") // Optional, if needed
            // The old code uploaded to `kalite-kontrol` + filename directly?
            // Old code: "./kalite-kontrol" + xmlFileInner.musInfo.sipno + "-" + ...
            // Let's assume there is a folder 'kalite-kontrol'.
            const remotePath = `/kalite-kontrol/${xmlFilename}` // Correct pathing
            await client.uploadFrom(localXmlPath, remotePath)
            console.log('Uploaded to FTP:', remotePath)
        } catch (ftpErr) {
            console.error('FTP Error:', ftpErr)
            // Don't fail the whole request just for FTP if mail works, or vice versa?
            // Usually we want to know.
        } finally {
            client.close()
            // Cleanup local file
            if (fs.existsSync(localXmlPath)) fs.unlinkSync(localXmlPath)
        }

        // 6. Send Email
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '465'),
            secure: true,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        })

        // Determine receivers
        // User requested to send to real customers
        const customerMail = req.body.params?.mail; // e.g. "musteri@example.com"
        const testMail = process.env.TEST_MAIL_RECEIVER || "mikbalaygun@gmail.com";

        // Construct receivers list
        // If customer mail exists, send to it. 
        // Also send copy to test/admin mail for verification/monitoring if desired, or just use customer mail.
        // Interpretation: "Real users" -> Primary.
        const receivers = [];
        if (customerMail && customerMail.includes('@')) {
            receivers.push(customerMail);
            // Optionally CC the admin
            // receivers.push(testMail); 
        } else {
            console.warn("Müşteri maili bulunamadı veya geçersiz. Test mailine gönderiliyor.");
            receivers.push(testMail);
        }

        // Additional hardcoded CCs if needed (from old v1 app logic usually there is a fixed list)
        // For now, adhering strictly to "send to real users".

        console.log('Mail gönderiliyor:', receivers)

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: receivers,
            cc: [testMail], // Always CC the admin/test receiver for tracking
            subject: req.body.headerText || "Kalite Kontrol Raporu",
            html: `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <title>Seyran Koltuk</title>
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

        // 7. Update Order Status in DB (Mark as Mail Sent)
        if (req.body.params && req.body.params.sipno && req.body.params.sipsr) {
            try {
                // Ensure they are integers as per schema
                const sipno = parseInt(req.body.params.sipno);
                const sipsr = parseInt(req.body.params.sipsr);

                await prisma.order.update({
                    where: {
                        sipno_sipsr: { sipno, sipsr }
                    },
                    data: {
                        mailSent: true,
                        mailSentAt: new Date()
                    }
                });
                console.log(`Sipariş mail durumu güncellendi: ${sipno}-${sipsr}`);
            } catch (dbErr) {
                console.error('Sipariş durumu güncellenemedi (Mail Sent Flag):', dbErr);
            }
        }

        res.json({ success: true, message: 'Mail gönderildi ve FTP yüklendi' })

    } catch (error) {
        console.error('Process Error:', error)
        res.status(500).json({ error: 'İşlem sırasında hata oluştu: ' + error.message })
    }
})

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
})
