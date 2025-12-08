require('dotenv').config();
const express = require('express');
const path = require('path');
const ejs = require('ejs');
const session = require('express-session');
const db = require('./config/db'); // Import the db object
const rateLimit = require('express-rate-limit'); // Import express-rate-limit
const methodOverride = require('method-override');

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
app.use(express.json()); // Added JSON parser here to be safe globally

app.use(methodOverride('_method'));

// Apply rate limiting to all requests (SAFE-03)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again after 15 minutes"
});
// app.use(limiter);

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files (CSS, images, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to make user object and unread notification count available to all templates
app.use(async (req, res, next) => {
    res.locals.user = req.session.user;
    res.locals.unreadNotificationsCount = 0; // Default to 0

    if (req.session.user) {
        try {
            // Switched to db.query for consistency with routes/app.js
            const [unreadNotifications] = await db.query(
                "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0",
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
// REMOVED: const authRoutes = require('./routes/auth'); 
// We only need app.js because it now contains EVERYTHING (Auth + App logic)
const appRoutes = require('./routes/app');

app.use('/', appRoutes); // Mount all routes at root

// Start the server only if this file is run directly
if (require.main === module) {
    // Optional: Run DB Init if you have that file
    try {
        const createDefaultAdmin = require('./init-db');
        createDefaultAdmin();
    } catch (e) {
        // init-db might not exist, safe to ignore
    }

    const host = process.env.HOST || '0.0.0.0'; 
    app.listen(port, host, () => {
        console.log(`Server listening on http://${host}:${port}`);
    });
}

module.exports = app;