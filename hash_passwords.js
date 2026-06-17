require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const hashPasswords = async () => {
    const client = await pool.connect();
    try {
        const result = await client.query('SELECT oid, username, password FROM operator');
        console.log(`Found ${result.rows.length} operators`);

        for (const user of result.rows) {
            // Skip if already hashed
            if (user.password.startsWith('$2b$') || user.password.startsWith('$2a$')) {
                console.log(`⏭️  Skipping ${user.username} (already hashed)`);
                continue;
            }

            const hashed = await bcrypt.hash(user.password, 10);
            await client.query('UPDATE operator SET password = $1 WHERE oid = $2', [hashed, user.oid]);
            console.log(`✅ Hashed password for: ${user.username}`);
        }

        console.log('\n✅ Done. All passwords are now hashed.');
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
};

hashPasswords();
