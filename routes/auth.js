const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../config/db');

router.get('/signup', (req, res) => {
    const message = req.session.flash;
    req.session.flash = null;
    res.render('signup', { message });
});

router.post('/signup', async (req, res) => {
    const { fullname, email, password } = req.body;
    try {
        const [existingUsers] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
        if (existingUsers.length > 0) {
            req.session.flash = 'User with this email already exists.';
            return res.redirect('/signup');
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        await db.execute(
            "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
            [fullname, email, hashedPassword]
        );
        res.redirect('/login');
    } catch (err) {
        console.error(err);
        req.session.flash = 'An error occurred during signup.';
        res.redirect('/signup');
    }
});

router.get('/login', (req, res) => {
    const message = req.session.flash;
    req.session.flash = null;
    res.render('loginPage', { message });
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
        if (users.length === 0) {
            req.session.flash = 'Invalid email or password.';
            return res.redirect('/login');
        }

        const user = users[0];
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (passwordMatch) {
            req.session.user = {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                avatar: user.avatar
            };
            res.redirect('/');
        } else {
            req.session.flash = 'Invalid email or password.';
            res.redirect('/login');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

// --- Password Reset Routes ---
const crypto = require('crypto');

router.get('/forgot-password', (req, res) => {
    const message = req.session.flash;
    req.session.flash = null;
    res.render('forgot-password', { message });
});

router.post('/forgot-password', async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { email } = req.body;
        const [users] = await connection.execute("SELECT * FROM users WHERE email = ?", [email]);
        if (users.length === 0) {
            await connection.rollback();
            req.session.flash = 'No account with that email address exists.';
            return res.redirect('/forgot-password');
        }

        const user = users[0];
        const token = crypto.randomBytes(20).toString('hex');
        const expires = new Date(Date.now() + 3600000); // 1 hour

        await connection.execute(
            "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)",
            [token, user.id, expires]
        );

        // In a real application, you would send an email here.
        // For now, we'll just log the reset link.
        console.log(`Password reset link for ${user.email}: http://localhost:3000/reset-password/${token}`);
        req.session.flash = 'If an account with that email exists, a password reset link has been sent.';
        
        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/forgot-password');

    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        req.session.flash = 'An error occurred during password reset request.';
        res.redirect('/forgot-password');
    } finally {
        if (connection) connection.release();
    }
});

router.get('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const [tokens] = await db.execute(
            "SELECT * FROM password_reset_tokens WHERE token = ? AND expires_at > NOW()",
            [token]
        );

        if (tokens.length === 0) {
            req.session.flash = 'Password reset token is invalid or has expired.';
            return res.redirect('/forgot-password');
        }
        const message = req.session.flash;
        req.session.flash = null;
        res.render('reset-password', { token, message });
    } catch (err) {
        console.error(err);
        req.session.flash = 'An error occurred.';
        res.redirect('/forgot-password');
    }
});

router.post('/reset-password/:token', async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { token } = req.params;
        const { password, confirmPassword } = req.body;

        if (password !== confirmPassword) {
            await connection.rollback();
            req.session.flash = 'Passwords do not match.';
            return res.redirect(`/reset-password/${token}`);
        }

        const [tokens] = await connection.execute(
            "SELECT * FROM password_reset_tokens WHERE token = ? AND expires_at > NOW()",
            [token]
        );

        if (tokens.length === 0) {
            await connection.rollback();
            req.session.flash = 'Password reset token is invalid or has expired.';
            return res.redirect('/forgot-password');
        }

        const resetToken = tokens[0];
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        await connection.execute(
            "UPDATE users SET password = ? WHERE id = ?",
            [hashedPassword, resetToken.user_id]
        );

        await connection.execute(
            "DELETE FROM password_reset_tokens WHERE token = ?",
            [token]
        );

        req.session.flash = 'Your password has been updated. Please log in.';
        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/login');

    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        req.session.flash = 'An error occurred while resetting your password.';
        res.redirect(`/reset-password/${token}`);
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
