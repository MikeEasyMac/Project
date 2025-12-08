const mysql = require('mysql2/promise');

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.NODE_ENV === 'test' ? 'root' : process.env.DB_USER,
    password: process.env.NODE_ENV === 'test' ? '' : process.env.DB_PASS,
    database: process.env.NODE_ENV === 'test' ? 'test_project' : process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = db;
