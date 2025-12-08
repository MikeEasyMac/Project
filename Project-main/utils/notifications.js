const db = require('../config/db');

async function createNotification(userId, type, message, link) {
    if (!userId || !message) {
        console.error("NOTIFICATION ERROR: Missing critical data. UserID:", userId, " Message:", message);
        return;
    }
    try {
        await db.execute(
            "INSERT INTO notifications (user_id, type, message, link, is_read) VALUES (?, ?, ?, ?, 0)",
            [userId, type, message, link || null] // Ensure link is null if missing
        );
        console.log(`Notification sent successfully to User ID: ${userId} for type: ${type}`);
    } catch (err) {
        // Log the actual SQL error if the insert fails
        console.error("NOTIFICATION SQL ERROR:", err);
    }
}

module.exports = { createNotification };
