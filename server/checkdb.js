const { Pool } = require('pg');

async function checkDB() {
    const pool = new Pool({
        user: 'postgres',
        host: 'localhost',
        database: 'multiplayer',
        password: '12345',
        port: 5432,
    });

    try {
        const result = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        console.log('Tables in multiplayer DB:', result.rows.map(r => r.table_name));
    } catch (error) {
        console.error('Error connecting to multiplayer DB:', error.message);
    } finally {
        await pool.end();
    }

    const poolLexy = new Pool({
        user: 'postgres',
        host: 'localhost',
        database: 'lexy',
        password: '12345',
        port: 5432,
    });

    try {
        console.log('Checking decks in lexy DB:');
        const decks = await poolLexy.query('SELECT id, name FROM decks LIMIT 10');
        console.log('Decks:', decks.rows);

        console.log('Checking user_decks:');
        const userDecks = await poolLexy.query('SELECT user_id, deck_id FROM user_decks WHERE user_id = 1 LIMIT 10'); // assuming user id 1
        console.log('User decks:', userDecks.rows);
    } catch (error) {
        console.error('Error with lexy DB:', error.message);
    } finally {
        await poolLexy.end();
    }
}

checkDB();