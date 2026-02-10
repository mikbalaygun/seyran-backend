
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
    const password = await bcrypt.hash('123123', 10)

    // Check if user exists
    const user = await prisma.user.findFirst({
        where: { username: 'admin' }
    });

    if (!user) {
        await prisma.user.create({
            data: {
                username: 'admin',
                password
            }
        })
        console.log('Admin user created (User: admin, Pass: 123123)')
    } else {
        console.log('Admin user already exists.')
    }
}

main()
    .catch(e => {
        console.error(e)
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
