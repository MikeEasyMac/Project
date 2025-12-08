const bcrypt = require('bcrypt');
const db = require('./config/db');

async function createDefaultAdmin() {
  const adminEmail = 'admin@example.com';
  const adminPassword = 'password';

  try {
    // Check if admin user already exists
    const [existingAdmin] = await db.execute('SELECT * FROM users WHERE email = ?', [adminEmail]);

    if (existingAdmin.length === 0) {
      // Hash the password
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(adminPassword, saltRounds);

      // Insert the admin user
      await db.execute(
        "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
        ['Admin User', adminEmail, hashedPassword, 'admin']
      );
      console.log('Default admin user created.');
    } else {
      console.log('Admin user already exists.');
    }
  } catch (error) {
    console.error('Error creating default admin user:', error);
  }
}

module.exports = createDefaultAdmin;
