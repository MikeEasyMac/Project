require('dotenv').config();
const express = require('express');
const path = require('path');
const ejs = require('ejs');
const session = require('express-session');
const db = require('./config/db'); // Import the db object
const rateLimit = require('express-rate-limit'); // Import express-rate-limit

const app = express();
const port = process.env.PORT || 3000;

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'a-very-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Middleware to parse URL-encoded bodies (as sent by HTML forms)
app.use(express.urlencoded({ extended: true }));

// Apply rate limiting to all requests (SAFE-03)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again after 15 minutes"
});
app.use(limiter);

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

// Serve static files (CSS, images, etc.)
app.use(express.static(path.join(__dirname, 'static')));

// Middleware to make user object and unread notification count available to all templates
app.use(async (req, res, next) => {
    res.locals.user = req.session.user;
    res.locals.unreadNotificationsCount = 0; // Default to 0

    if (req.session.user) {
        try {
            const [unreadNotifications] = await db.execute(
                "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = FALSE",
                [req.session.user.id]
            );
            res.locals.unreadNotificationsCount = unreadNotifications[0].count;
        } catch (err) {
            console.error("Error fetching unread notifications:", err);
        }
    }
    next();
});

// --- Routers ---
const authRoutes = require('./routes/auth');
const appRoutes = require('./routes/app');

app.use(authRoutes);
app.use(appRoutes);


// Start the server only if this file is run directly
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });
}

module.exports = app;
