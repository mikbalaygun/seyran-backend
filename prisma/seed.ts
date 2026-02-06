// @ts-nocheck
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
    console.log('Seeding database...')

    // 1. Create/Update Admin User
    const hashedPassword = await bcrypt.hash('2026!?', 10)
    const user = await prisma.user.upsert({
        where: { username: 'seyran' },
        update: { password: hashedPassword },
        create: {
            username: 'seyran',
            password: hashedPassword,
        },
    })

    // Optional: Delete old 'admin' user if needed
    try {
        await prisma.user.delete({ where: { username: 'admin' } });
        console.log('Deleted legacy admin user');
    } catch (e) { /* ignore if not found */ }
    console.log({ user })

    // 2. Import Orders from q-ctrl.json
    const jsonPath = path.join(__dirname, '../../q-ctrl.json')

    if (fs.existsSync(jsonPath)) {
        const rawData = fs.readFileSync(jsonPath, 'utf-8')
        const data = JSON.parse(rawData)
        const orders = data.wtemp

        console.log(`Found ${orders.length} orders in JSON. Importing...`)

        // Use a transaction or batch if possible, but loop is fine for < 1000 items
        let count = 0;
        for (const order of orders) {
            // Check if order exists to avoid duplicates (using sipno + sipsr)
            const exists = await prisma.order.findUnique({
                where: {
                    sipno_sipsr: {
                        sipno: order.sipno,
                        sipsr: order.sipsr,
                    }
                }
            })

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
                })
                count++;
            }
        }
        console.log(`${count} new orders imported!`)
    } else {
        console.warn('q-ctrl.json not found, skipping order import.')
    }
}

main()
    .then(async () => {
        await prisma.$disconnect()
    })
    .catch(async (e) => {
        console.error(e)
        await prisma.$disconnect()
        process.exit(1)
    })
