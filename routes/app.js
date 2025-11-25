const express = require('express');
const router = express.Router();
const db = require('../config/db');
const path = require('path');
const ejs = require('ejs');

// --- Middleware for route protection ---
const isAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    }
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }
    res.status(403).send('Forbidden');
};

const isTutor = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'tutor') {
        return next();
    }
    res.status(403).send('Forbidden');
};

const isStudent = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'student') {
        return next();
    }
    res.status(403).send('Forbidden');
};


router.get('/', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [stats] = await db.execute("SELECT COUNT(*) AS users, (SELECT COUNT(*) FROM todos) AS todos FROM users;");
        const [items] = await db.execute("SELECT title FROM todos ORDER BY id DESC LIMIT 20;");

        // Fetch upcoming assignments (STU-08)
        const [upcomingAssignments] = await db.execute(
            `SELECT a.title, a.due_date, c.title AS course_title
             FROM assignments a
             JOIN courses c ON a.course_id = c.id
             WHERE a.user_id = ? AND a.status = 'pending' AND a.due_date > NOW()
             ORDER BY a.due_date ASC
             LIMIT 5`,
            [userId]
        );

        // Fetch upcoming study sessions (STU-08)
        const [upcomingStudySessions] = await db.execute(
            `SELECT ss.title, ss.start_time, ss.end_time, a.title AS assignment_title
             FROM study_sessions ss
             LEFT JOIN assignments a ON ss.assignment_id = a.id
             WHERE ss.user_id = ? AND ss.status = 'planned' AND ss.start_time > NOW()
             ORDER BY ss.start_time ASC
             LIMIT 5`,
            [userId]
        );

        // Corrected Syntax:

res.render('base', {
    mainTemplate: 'index', 
    users: stats[0].users,
    todos: stats[0].todos,
    items: items,
    upcomingAssignments: upcomingAssignments,
    upcomingStudySessions: upcomingStudySessions
}); 
} catch (err) { 
    console.error(err);
    res.status(500).send('Internal Server Error');
}

});

router.post('/todo', isAuthenticated, async (req, res) => {
    try {
        const title = req.body.title.trim();
        if (title) {
            const [result] = await db.execute("INSERT INTO todos(title) VALUES (?)", [title]);
            const insertId = result.insertId;
            const [rows] = await db.execute("SELECT * FROM todos WHERE id = ?", [insertId]);
            const newTodo = rows[0];

            // If it's an AJAX request, respond with JSON
            if (req.xhr || req.headers.accept.indexOf('json') > -1) {
                return res.json(newTodo);
            }
        }
        // For traditional form submissions, redirect
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/courses', isAuthenticated, async (req, res) => {
    try {
        const [courses] = await db.execute("SELECT * FROM courses ORDER BY id DESC;");
        
        
        res.render('base', {
            mainTemplate: 'courses', 
            courses: courses         
        });
        

    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/courses/:courseId/enroll', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const courseId = req.params.courseId;
        const userId = req.session.user.id;

        // SAFE-04: Check for duplicate enrollment
        const [existingEnrollment] = await connection.execute(
            "SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?",
            [userId, courseId]
        );

        if (existingEnrollment.length > 0) {
            await connection.rollback();
            return res.status(409).send('You are already enrolled in this course.'); // SAFE-01: Clear error message
        }

        await connection.execute(
            "INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)",
            [userId, courseId]
        );

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/courses');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Error enrolling in course.'); // SAFE-01: Clear error message
    } finally {
        if (connection) connection.release();
    }
});

router.get('/my-courses', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [courses] = await db.execute(
            `SELECT c.id, c.code, c.title 
             FROM courses c
             JOIN enrollments e ON c.id = e.course_id
             WHERE e.user_id = ?`,
            [userId]
        );

        // Fetch assignments for each course
        for (let course of courses) {
            const [assignments] = await db.execute(
                "SELECT * FROM assignments WHERE user_id = ? AND course_id = ? ORDER BY due_date ASC",
                [userId, course.id]
            );
            course.assignments = assignments;
        }

        res.render('base', {
            mainTemplate: 'my-courses', 
            courses: courses
        });
        
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

// --- Assignment Routes ---
router.get('/assignments/add', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [courses] = await db.execute(
            `SELECT c.id, c.title 
             FROM courses c
             JOIN enrollments e ON c.id = e.course_id
             WHERE e.user_id = ?`,
            [userId]
        );
        res.render('base', {
            mainTemplate: 'add-assignment', 
            courses: courses
        
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/assignments', isAuthenticated, async (req, res) => {
    try {
        const { course_id, title, due_date, effort_estimate } = req.body;
        const userId = req.session.user.id;

        // SAFE-07: Validate due_date
        if (due_date) {
            const dueDateObj = new Date(due_date);
            const now = new Date();
            if (isNaN(dueDateObj.getTime())) {
                return res.status(400).send('Invalid due date format.'); // SAFE-01
            }
            if (dueDateObj < now) {
                return res.status(400).send('Due date cannot be in the past.'); // SAFE-01
            }
        }

        await db.execute(
            "INSERT INTO assignments (user_id, course_id, title, due_date, effort_estimate) VALUES (?, ?, ?, ?, ?)",
            [userId, course_id, title, due_date || null, effort_estimate || null]
        );
        res.redirect('/my-courses'); // Redirect to a page that lists assignments
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/assignments/:id/edit', isAuthenticated, async (req, res) => {
    try {
        const assignmentId = req.params.id;
        const userId = req.session.user.id;

        const [assignments] = await db.execute("SELECT * FROM assignments WHERE id = ? AND user_id = ?", [assignmentId, userId]);
        if (assignments.length === 0) {
            return res.status(404).send('Assignment not found or not authorized.');
        }
        const assignment = assignments[0];

        const [courses] = await db.execute(
            `SELECT c.id, c.title 
             FROM courses c
             JOIN enrollments e ON c.id = e.course_id
             WHERE e.user_id = ?`,
            [userId]
        );

        res.render('base', {
            mainTemplate: 'edit-assignment', 
            assignment: assignment,
            courses: courses
        });

    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/assignments/:id', isAuthenticated, async (req, res) => {
    try {
        const assignmentId = req.params.id;
        const userId = req.session.user.id;
        const { course_id, title, due_date, effort_estimate, status } = req.body;

        // SAFE-07: Validate due_date
        if (due_date) {
            const dueDateObj = new Date(due_date);
            const now = new Date();
            if (isNaN(dueDateObj.getTime())) {
                return res.status(400).send('Invalid due date format.'); // SAFE-01
            }
            if (dueDateObj < now) {
                return res.status(400).send('Due date cannot be in the past.'); // SAFE-01
            }
        }

        await db.execute(
            "UPDATE assignments SET course_id = ?, title = ?, due_date = ?, effort_estimate = ?, status = ? WHERE id = ? AND user_id = ?",
            [course_id, title, due_date || null, effort_estimate || null, status, assignmentId, userId]
        );
        res.redirect('/my-courses'); // Redirect to a page that lists assignments
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/assignments/:id/delete', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const assignmentId = req.params.id;
        const userId = req.session.user.id;

        await connection.execute("DELETE FROM assignments WHERE id = ? AND user_id = ?", [assignmentId, userId]);

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/my-courses'); // Redirect to a page that lists assignments
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

router.post('/assignments/:id/status', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const assignmentId = req.params.id;
        const userId = req.session.user.id;
        const { status } = req.body; // Expect status to be 'pending', 'completed', 'overdue'

        await connection.execute("UPDATE assignments SET status = ? WHERE id = ? AND user_id = ?", [status, assignmentId, userId]);

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/my-courses'); // Redirect to a page that lists assignments
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

// --- Study Session Routes ---
router.get('/study-sessions', isAuthenticated, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const userId = req.session.user.id;

        let query = `
            SELECT ss.*, a.title AS assignment_title, c.title AS course_title
            FROM study_sessions ss
            LEFT JOIN assignments a ON ss.assignment_id = a.id
            LEFT JOIN courses c ON a.course_id = c.id
            WHERE ss.user_id = ?
        `;
        const params = [userId];

        let countQuery = `
            SELECT COUNT(*) AS count
            FROM study_sessions ss
            LEFT JOIN assignments a ON ss.assignment_id = a.id
            LEFT JOIN courses c ON a.course_id = c.id
            WHERE ss.user_id = ?
        `;
        const countParams = [userId];

        const [totalSessions] = await db.execute(countQuery, countParams);
        const totalPages = Math.ceil(totalSessions[0].count / parseInt(limit));

        query += ` ORDER BY ss.start_time ASC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [studySessions] = await db.execute(query, params);
        res.render('base', {
    mainTemplate: 'study-sessions', 
    studySessions: studySessions,
    currentPage: parseInt(page),
    totalPages: totalPages
});
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/study-sessions/add', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [assignments] = await db.execute(
            `SELECT a.id, a.title, c.title AS course_title
             FROM assignments a
             JOIN courses c ON a.course_id = c.id
             WHERE a.user_id = ?
             ORDER BY a.due_date ASC`,
            [userId]
        );
        res.render('base', {
            mainTemplate: 'add-study-session', 
            assignments: assignments
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/study-sessions', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { title, assignment_id, start_time, end_time, notes } = req.body;
        const userId = req.session.user.id;

        // SAFE-06 & SAFE-07: Server-side validation for dates and times
        const startTimeObj = new Date(start_time);
        const endTimeObj = new Date(end_time);
        const now = new Date();

        if (isNaN(startTimeObj.getTime()) || isNaN(endTimeObj.getTime())) {
            await connection.rollback();
            return res.status(400).send('Invalid start or end time format.'); // SAFE-01: Clear error message
        }
        if (startTimeObj >= endTimeObj) {
            await connection.rollback();
            return res.status(400).send('End time must be after start time.'); // SAFE-01: Clear error message
        }
        if (startTimeObj < now) {
            await connection.rollback();
            return res.status(400).send('Cannot schedule a study session in the past.'); // SAFE-01: Clear error message
        }

        // Conflict detection (STU-06)
        const [conflictingSessions] = await connection.execute(
            `SELECT * FROM study_sessions
             WHERE user_id = ?
             AND (
                 (start_time < ? AND end_time > ?) OR
                 (start_time < ? AND end_time > ?) OR
                 (start_time = ? AND end_time = ?)
             )`,
            [userId, endTimeObj, startTimeObj, startTimeObj, endTimeObj, startTimeObj, endTimeObj]
        );

        if (conflictingSessions.length > 0) {
            await connection.rollback();
            return res.status(409).send('Conflict: This study session overlaps with an existing one.'); // SAFE-01: Clear error message
        }

        await connection.execute(
            "INSERT INTO study_sessions (user_id, assignment_id, title, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?, ?)",
            [userId, assignment_id || null, title, startTimeObj, endTimeObj, notes] // Store as UTC
        );

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/study-sessions');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

router.get('/study-sessions/:id/edit', isAuthenticated, async (req, res) => {
    try {
        const sessionId = req.params.id;
        const userId = req.session.user.id;

        const [sessions] = await db.execute("SELECT * FROM study_sessions WHERE id = ? AND user_id = ?", [sessionId, userId]);
        if (sessions.length === 0) {
            return res.status(404).send('Study session not found or not authorized.');
        }
        const session = sessions[0];

        const [assignments] = await db.execute(
            `SELECT a.id, a.title, c.title AS course_title
             FROM assignments a
             JOIN courses c ON a.course_id = c.id
             WHERE a.user_id = ?
             ORDER BY a.due_date ASC`,
            [userId]
        );

        res.render('base', {
            mainTemplate: 'edit-study-session', 
            session: session,
            assignments: assignments
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/study-sessions/:id', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const sessionId = req.params.id;
        const userId = req.session.user.id;
        const { title, assignment_id, start_time, end_time, status, notes } = req.body;

        // SAFE-06 & SAFE-07: Server-side validation for dates and times
        const startTimeObj = new Date(start_time);
        const endTimeObj = new Date(end_time);
        const now = new Date();

        if (isNaN(startTimeObj.getTime()) || isNaN(endTimeObj.getTime())) {
            await connection.rollback();
            return res.status(400).send('Invalid start or end time format.'); // SAFE-01: Clear error message
        }
        if (startTimeObj >= endTimeObj) {
            await connection.rollback();
            return res.status(400).send('End time must be after start time.'); // SAFE-01: Clear error message
        }
        if (startTimeObj < now) {
            await connection.rollback();
            return res.status(400).send('Cannot schedule a study session in the past.'); // SAFE-01: Clear error message
        }

        // Conflict detection (STU-06) - exclude current session from conflict check
        const [conflictingSessions] = await connection.execute(
            `SELECT * FROM study_sessions
             WHERE user_id = ? AND id != ?
             AND (
                 (start_time < ? AND end_time > ?) OR
                 (start_time < ? AND end_time > ?) OR
                 (start_time = ? AND end_time = ?)
             )`,
            [userId, sessionId, endTimeObj, startTimeObj, startTimeObj, endTimeObj, startTimeObj, endTimeObj]
        );

        if (conflictingSessions.length > 0) {
            await connection.rollback();
            return res.status(409).send('Conflict: This study session overlaps with an existing one.'); // SAFE-01: Clear error message
        }

        await connection.execute(
            "UPDATE study_sessions SET title = ?, assignment_id = ?, start_time = ?, end_time = ?, status = ?, notes = ? WHERE id = ? AND user_id = ?",
            [title, assignment_id || null, startTimeObj, endTimeObj, status, notes, sessionId, userId] // Store as UTC
        );

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/study-sessions');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

router.post('/study-sessions/:id/delete', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const sessionId = req.params.id;
        const userId = req.session.user.id;

        await connection.execute("DELETE FROM study_sessions WHERE id = ? AND user_id = ?", [sessionId, userId]);

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/study-sessions');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

router.post('/study-sessions/:id/status', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const sessionId = req.params.id;
        const userId = req.session.user.id;
        const { status } = req.body;

        await connection.execute("UPDATE study_sessions SET status = ? WHERE id = ? AND user_id = ?", [status, sessionId, userId]);

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/study-sessions');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

// STU-03: Generate Study Plan
router.post('/assignments/:id/generate-plan', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const assignmentId = req.params.id;
        const userId = req.session.user.id;

        const [assignments] = await connection.execute("SELECT * FROM assignments WHERE id = ? AND user_id = ?", [assignmentId, userId]);
        if (assignments.length === 0) {
            await connection.rollback();
            return res.status(404).send('Assignment not found or not authorized.'); // SAFE-01
        }
        const assignment = assignments[0];

        if (!assignment.effort_estimate || !assignment.due_date) {
            await connection.rollback();
            return res.status(400).send('Effort estimate and due date are required to generate a plan.'); // SAFE-01
        }

        // SAFE-07: Validate due_date
        const dueDateObj = new Date(assignment.due_date);
        const now = new Date();
        if (isNaN(dueDateObj.getTime())) {
            await connection.rollback();
            return res.status(400).send('Invalid due date format for assignment.'); // SAFE-01
        }
        if (dueDateObj < now) {
            await connection.rollback();
            return res.status(400).send('Cannot generate a study plan for an assignment with a past due date.'); // SAFE-01
        }

        const effortInMinutes = assignment.effort_estimate;
        const sessionDuration = 60; // minutes per session
        let remainingEffort = effortInMinutes;
        let currentDateTime = new Date(dueDateObj.getTime()); // Start from due date and go backwards

        while (remainingEffort > 0) {
            currentDateTime.setMinutes(currentDateTime.getMinutes() - sessionDuration);

            const potentialStartTime = new Date(currentDateTime.getTime());
            const potentialEndTime = new Date(currentDateTime.getTime() + sessionDuration * 60 * 1000);

            const startHour = potentialStartTime.getHours();
            if (startHour >= 9 && startHour <= 20) {
                const [conflictingSessions] = await connection.execute(
                    `SELECT * FROM study_sessions
                     WHERE user_id = ?
                     AND (
                         (start_time < ? AND end_time > ?) OR
                         (start_time < ? AND end_time > ?) OR
                         (start_time = ? AND end_time = ?)
                     )`,
                    [userId, potentialEndTime, potentialStartTime, potentialStartTime, potentialEndTime, potentialStartTime, potentialEndTime]
                );

                if (conflictingSessions.length === 0) {
                    await connection.execute(
                        "INSERT INTO study_sessions (user_id, assignment_id, title, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?, ?)",
                        [userId, assignmentId, `${assignment.title} Study Session`, potentialStartTime, potentialEndTime, `Auto-generated for ${assignment.title}`]
                    );
                    remainingEffort -= sessionDuration;
                }
            }

            if (currentDateTime.getTime() < Date.now() - (30 * 24 * 60 * 60 * 1000)) {
                console.warn("Could not generate all study sessions for assignment due to lack of available slots or too far in the past.");
                break;
            }
        }

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/study-sessions');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

router.get('/profile', isAuthenticated, async (req, res) => {
    try {
        const [users] = await db.execute("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
        if (users.length === 0) {
            return res.redirect('/login');
        }
        const user = users[0];
        res.render('base', {
            mainTemplate: 'profile',
            user: user
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/profile', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { fullname, avatar } = req.body;
        const userId = req.session.user.id;

        await connection.execute(
            "UPDATE users SET name = ?, avatar = ? WHERE id = ?",
            [fullname, avatar, userId]
        );

        // Update session data
        req.session.user.name = fullname;
        req.session.user.avatar = avatar;

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/profile');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

router.get('/users', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [users] = await db.execute("SELECT name,email FROM users ORDER BY id DESC;");
        res.render('base', {
            mainTemplate: 'users',
            users: users
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/tutor/profile', isAuthenticated, isTutor, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const userId = req.session.user.id;
        
        // Sanitize incoming body fields, replacing undefined/empty with null
        const bio = req.body.bio || null; 
        const subjects = req.body.subjects || null;
        const availability = req.body.availability || null;
        
        // --- 1. SAFE SUBJECT PARSING ---
        let parsedSubjects = '[]';
        if (subjects && subjects.trim() !== '') {
            // Converts comma-separated text into a JSON array string
            parsedSubjects = JSON.stringify(subjects.split(',').map(s => s.trim()));
        }

        // --- 2. SAFE AVAILABILITY PARSING ---
        let dbAvailability = '""'; // Default to empty string wrapped in JSON
        if (availability && availability.trim() !== '') {
            // Ensure the plain text is wrapped as a valid JSON string for the column
            // e.g., "Mondays 3-5pm" becomes '"Mondays 3-5pm"'
            dbAvailability = JSON.stringify(availability.trim());
        }

        // --- 3. DATABASE UPDATE ---
        const [existingTutors] = await connection.execute("SELECT * FROM tutors WHERE user_id = ?", [userId]);

        if (existingTutors.length > 0) {
            // UPDATE: 4 placeholders for columns + 1 for WHERE clause = 5 bind parameters
            await connection.execute(
                "UPDATE tutors SET bio = ?, subjects = ?, availability = ? WHERE user_id = ?",
                [bio, parsedSubjects, dbAvailability, userId] 
            );
        } else {
            // INSERT: 4 placeholders for columns = 4 bind parameters
            await connection.execute(
                "INSERT INTO tutors (user_id, bio, subjects, availability) VALUES (?, ?, ?, ?)",
                [userId, bio, parsedSubjects, dbAvailability]
            );
        }

        await connection.commit();
        res.redirect('/tutor#profile-content'); // Redirect after successful save
    } catch (err) {
        if (connection) await connection.rollback();
        console.error("Profile Update Error:", err);
        res.status(500).send('Error saving profile.'); 
    } finally {
        if (connection) connection.release();
    }
});

router.get('/tutor', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const tutorUserId = req.session.user.id;
        
        // 1. FETCH TUTOR PROFILE
        const [tutorProfileData] = await db.execute(
            `SELECT t.id, u.name, t.bio, t.subjects, t.availability 
             FROM tutors t
             JOIN users u ON t.user_id = u.id
             WHERE t.user_id = ?`,
            [tutorUserId]
        );

        if (tutorProfileData.length === 0) {
            return res.status(403).send('Tutor profile not found.');
        }
        const tutorProfile = tutorProfileData[0]; 
        const tutorId = tutorProfile.id; 

        // 2. FETCH OPEN REQUESTS
        let openRequestsQuery = `
            SELECT tr.*, u.name AS student_name
             FROM tutoring_requests tr
             JOIN users u ON tr.student_id = u.id
             WHERE tr.tutor_id = ? AND tr.status = 'pending'
             ORDER BY tr.created_at ASC 
             LIMIT ? OFFSET ?
        `;
        // Fetch count for pagination
        const [totalOpenRequests] = await db.execute(`SELECT COUNT(*) AS count FROM tutoring_requests WHERE tutor_id = ? AND status = 'pending'`, [tutorId]);
        const totalOpenRequestPages = Math.ceil(totalOpenRequests[0].count / parseInt(limit));
        
        const [openRequests] = await db.execute(openRequestsQuery, [tutorId, parseInt(limit), parseInt(offset)]);

        // 3. FETCH UPCOMING SESSIONS
        let upcomingSessionsQuery = `
        SELECT ts.*, tr.topic, u.name AS student_name
         FROM tutoring_sessions ts
         JOIN tutoring_requests tr ON ts.request_id = tr.id
         JOIN users u ON tr.student_id = u.id
         WHERE tr.tutor_id = ? AND ts.status = 'scheduled' AND ts.end_time > NOW()
         ORDER BY ts.start_time ASC
         LIMIT ? OFFSET ?
    `;
        // Fetch count for pagination
        // CORRECTED totalUpcomingSessions COUNT Query
const [totalUpcomingSessions] = await db.execute(
    `SELECT COUNT(*) AS count FROM tutoring_sessions ts 
     JOIN tutoring_requests tr ON ts.request_id = tr.id 
     WHERE tr.tutor_id = ? AND ts.status = 'scheduled' AND ts.end_time > NOW()`, 
    [tutorId]
);

        const totalUpcomingSessionPages = Math.ceil(totalUpcomingSessions[0].count / parseInt(limit));
        
        const [upcomingSessions] = await db.execute(upcomingSessionsQuery, [tutorId, parseInt(limit), parseInt(offset)]);

        // 4. FETCH PAST SESSIONS
        let pastSessionsQuery = `
            SELECT ts.*, tr.topic, u.name AS student_name
             FROM tutoring_sessions ts
             JOIN tutoring_requests tr ON ts.request_id = tr.id
             JOIN users u ON tr.student_id = u.id
             WHERE tr.tutor_id = ? AND ts.status IN ('completed', 'cancelled')
             ORDER BY ts.start_time DESC
             LIMIT ? OFFSET ?
        `;
        // Fetch count for pagination
        const [totalPastSessions] = await db.execute(`SELECT COUNT(*) AS count FROM tutoring_sessions ts JOIN tutoring_requests tr ON ts.request_id = tr.id WHERE tr.tutor_id = ? AND ts.status IN ('completed', 'cancelled')`, [tutorId]);
        const totalPastSessionPages = Math.ceil(totalPastSessions[0].count / parseInt(limit));
        
        const [pastSessions] = await db.execute(pastSessionsQuery, [tutorId, parseInt(limit), parseInt(offset)]);

        // 5. FETCH RESOURCES (The missing piece!)
        // Note: resources usually belong to the user_id, not the tutor_id
        const [resources] = await db.execute(
            `SELECT * FROM resources WHERE user_id = ? ORDER BY created_at DESC`, 
            [tutorUserId]
        );

        // FINAL RENDER
        res.render('base', {
            mainTemplate: 'tutor',
            tutor: tutorProfile,
            openRequests: openRequests,
            upcomingSessions: upcomingSessions,
            pastSessions: pastSessions,
            resources: resources,
            user: req.session.user, // <-- This fixes the new error!
            
            // Pagination variables
            currentOpenRequestPage: parseInt(page),
            totalOpenRequestPages: totalOpenRequestPages,
            currentUpcomingSessionPage: parseInt(page),
            totalUpcomingSessionPages: totalUpcomingSessionPages,
            currentPastSessionPage: parseInt(page),
            totalPastSessionPages: totalPastSessionPages,
            
            // Pass the user object explicitly if base.ejs needs it and res.locals isn't set
            user: req.session.user 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

// --- Tutor Discovery & Scheduling Routes ---
router.get('/tutors', isAuthenticated, async (req, res) => {
    try {
        const [tutors] = await db.execute(
            // Removed t.hourly_rate from the SELECT list
            `SELECT t.id, u.name, t.bio, t.subjects
             FROM tutors t
             JOIN users u ON t.user_id = u.id`
        );

        // SAFE-05: Handle unavailable tutors
        // --- CORRECTED RENDERING ---
        if (tutors.length === 0) {
            return res.render('base', {
                mainTemplate: 'tutors',
                tutors: [],
                message: 'No tutors are currently available. Please check back later.',
                user: req.session.user
            });
        }
// -------------------------

res.render('base', {
    mainTemplate: 'tutors',
    tutors: tutors,
    user: req.session.user
});
} catch (err) {
console.error(err);
res.status(500).send('Internal Server Error');
}
});

router.get('/tutors/:id/request', isAuthenticated, async (req, res) => {
    try {
        const tutorId = req.params.id;
        const [tutors] = await db.execute(
            `SELECT t.id, u.name
             FROM tutors t
             JOIN users u ON t.user_id = u.id
             WHERE t.id = ?`,
            [tutorId]
        );
        if (tutors.length === 0) {
            return res.status(404).send('Tutor not found.'); // SAFE-01: Clear error message
        }
        const tutor = tutors[0];
        res.render('base', {
            mainTemplate: 'request_tutor',
            tutor: tutor,
            user: req.session.user
        
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/tutors/:id/request', isAuthenticated, async (req, res) => {
    let connection; // Single connection declaration here
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const tutorId = req.params.id;
        const studentId = req.session.user.id;
        
        // 1. Get data from the form (using the new plain text field)
        const { topic, proposed_times_text, details } = req.body; 

        // 2. Prepare the preferred time text for the JSON column
        const preferredTimeWindows = proposed_times_text ? proposed_times_text.trim() : 'N/A';
        
        // CRITICAL FIX: To satisfy the DB's JSON column constraint, 
        // we wrap the plain text string in quotes, making it a valid JSON string.
        const dbTimeWindows = JSON.stringify(preferredTimeWindows); 

        // 3. Execute the single, correct INSERT query
        await connection.execute(
            "INSERT INTO tutoring_requests (student_id, tutor_id, topic, preferred_time_windows, details) VALUES (?, ?, ?, ?, ?)",
            [studentId, tutorId, topic, dbTimeWindows, details]
        );

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/my-tutoring-requests');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error("Tutoring Request Error:", err);
        res.status(500).send('Internal Server Error: Failed to submit request.'); // SAFE-01: Clear error message
    } finally {
        if (connection) connection.release();
    }
});

router.get('/my-tutoring-requests', isAuthenticated, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const studentId = req.session.user.id;

        let query = `
            SELECT tr.*, u.name AS tutor_name,
                    ts.id AS session_id, ts.start_time AS session_start_time, ts.end_time AS session_end_time,
                    ts.status AS session_status, ts.tutor_notes, ts.student_feedback,
                    CASE WHEN ts.id IS NOT NULL THEN TRUE ELSE FALSE END AS session_scheduled
             FROM tutoring_requests tr
             JOIN users u ON tr.tutor_id = u.id
             LEFT JOIN tutoring_sessions ts ON tr.id = ts.request_id
             WHERE tr.student_id = ?
        `;
        const params = [studentId];

        let countQuery = `
            SELECT COUNT(*) AS count
            FROM tutoring_requests tr
            JOIN users u ON tr.tutor_id = u.id
            LEFT JOIN tutoring_sessions ts ON tr.id = ts.request_id
            WHERE tr.student_id = ?
        `;
        const countParams = [studentId];

        const [totalRequests] = await db.execute(countQuery, countParams);
        const totalPages = Math.ceil(totalRequests[0].count / parseInt(limit));

        query += ` ORDER BY tr.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [tutoringRequests] = await db.execute(query, params);
        res.render('base', {
            mainTemplate: 'my-tutoring-requests',
            tutoringRequests: tutoringRequests,
            currentPage: parseInt(page),
            totalPages: totalPages
        
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/tutoring-requests/:id/confirm', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const requestId = req.params.id;
        const studentId = req.session.user.id;

        // Check if the request exists and belongs to the student
        const [requests] = await connection.execute("SELECT * FROM tutoring_requests WHERE id = ? AND student_id = ?", [requestId, studentId]);
        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).send('Tutoring request not found or not authorized.'); // SAFE-01
        }
        const request = requests[0];

        // Assuming proposed times are stored in the request or session table after tutor accepts
        // For this implementation, we'll fetch the proposed times from the newly created session
        const [sessions] = await connection.execute("SELECT * FROM tutoring_sessions WHERE request_id = ?", [requestId]);
        if (sessions.length === 0) {
            await connection.rollback();
            return res.status(400).send('No proposed session found to confirm.'); // SAFE-01
        }
        const session = sessions[0];

        // SAFE-06 & SAFE-07: Server-side validation for proposed session times
        const proposedStartTimeObj = new Date(session.start_time);
        const proposedEndTimeObj = new Date(session.end_time);
        const now = new Date();

        if (isNaN(proposedStartTimeObj.getTime()) || isNaN(proposedEndTimeObj.getTime())) {
            await connection.rollback();
            return res.status(400).send('Invalid proposed session time format.'); // SAFE-01
        }
        if (proposedStartTimeObj >= proposedEndTimeObj) {
            await connection.rollback();
            return res.status(400).send('Proposed session end time must be after start time.'); // SAFE-01
        }
        if (proposedStartTimeObj < now) {
            await connection.rollback();
            return res.status(400).send('Cannot confirm a session that starts in the past.'); // SAFE-01
        }

        // Only confirm if status is 'accepted' and not already scheduled
        if (request.status === 'accepted' && session.status !== 'scheduled') {
            // Update session status to scheduled
            await connection.execute("UPDATE tutoring_sessions SET status = 'scheduled' WHERE id = ?", [session.id]);

            // Create notification for the tutor (NOT-01)
            const [tutorUser] = await connection.execute("SELECT user_id FROM tutors WHERE id = ?", [request.tutor_id]);
            if (tutorUser.length > 0) {
                await connection.execute(
                    "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
                    [tutorUser[0].user_id, 'session_confirmed', `Your proposed session for '${request.topic}' with ${req.session.user.name} has been confirmed.`, `/tutor/requests`]
                );
            }

            // ADM-05: Audit Log
            await connection.execute(
                "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
                [req.session.user.id, 'tutoring_session_confirmed', 'tutoring_session', session.id, JSON.stringify({ student_id: studentId, tutor_id: request.tutor_id })]
            );

            await connection.commit(); // SAFE-02: Atomic action
            res.redirect('/my-tutoring-requests');
        } else {
            await connection.rollback();
            return res.status(400).send('Cannot confirm this request.'); // SAFE-01
        }
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

router.post('/tutoring-requests/:id/cancel', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const requestId = req.params.id;
        const studentId = req.session.user.id;

        // Check if the request exists and belongs to the student
        const [requests] = await connection.execute("SELECT * FROM tutoring_requests WHERE id = ? AND student_id = ?", [requestId, studentId]);
        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).send('Tutoring request not found or not authorized.'); // SAFE-01
        }

        // Update request status to 'cancelled'
        await connection.execute("UPDATE tutoring_requests SET status = 'cancelled' WHERE id = ?", [requestId]);

        // Also cancel any associated scheduled session
        await connection.execute("UPDATE tutoring_sessions SET status = 'cancelled' WHERE request_id = ?", [requestId]);

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'tutoring_request_cancelled', 'tutoring_request', requestId, JSON.stringify({ student_id: studentId })]
        );

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/my-tutoring-requests');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

router.post('/tutoring-sessions/:id/feedback', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const sessionId = req.params.id;
        const studentId = req.session.user.id;
        const { feedback } = req.body;

        // Verify that the session belongs to a request made by this student
        const [sessions] = await connection.execute(
            `SELECT ts.* FROM tutoring_sessions ts
             JOIN tutoring_requests tr ON ts.request_id = tr.id
             WHERE ts.id = ? AND tr.student_id = ?`,
            [sessionId, studentId]
        );

        if (sessions.length === 0) {
            await connection.rollback();
            return res.status(404).send('Tutoring session not found or not authorized.');
        }

        await connection.execute("UPDATE tutoring_sessions SET student_feedback = ? WHERE id = ?", [feedback, sessionId]);

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'tutoring_session_feedback_added', 'tutoring_session', sessionId, JSON.stringify({ student_id: studentId, feedback: feedback })]
        );

        await connection.commit();
        res.redirect('/my-tutoring-requests');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

// When tutor accepts a request (TUT-02, NOT-01)
router.post('/tutor/requests/:id/accept', isAuthenticated, isTutor, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const requestId = req.params.id;
        const tutorUserId = req.session.user.id;
        const { proposed_start_time, proposed_end_time } = req.body;

        const [tutorData] = await connection.execute("SELECT id FROM tutors WHERE user_id = ?", [tutorUserId]);
        if (tutorData.length === 0) {
            await connection.rollback();
            return res.status(403).send('Tutor profile not found.');
        }
        const tutorId = tutorData[0].id;

        const [requests] = await connection.execute("SELECT * FROM tutoring_requests WHERE id = ? AND tutor_id = ?", [requestId, tutorId]);
        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).send('Tutoring request not found or not authorized.');
        }
        const request = requests[0];

        await connection.execute("UPDATE tutoring_requests SET status = 'accepted' WHERE id = ?", [requestId]);

        await connection.execute(
            "INSERT INTO tutoring_sessions (request_id, start_time, end_time, status) VALUES (?, ?, ?, ?)",
            [requestId, proposed_start_time, proposed_end_time, 'scheduled']
        );

        // Create notification for the student (NOT-01)
        await connection.execute(
            "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
            [request.student_id, 'tutor_request_accepted', `Your tutoring request for '${request.topic}' has been accepted by ${req.session.user.name}.`, `/my-tutoring-requests`]
        );

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'tutoring_request_accepted', 'tutoring_request', requestId, JSON.stringify({ tutor_id: tutorId, student_id: request.student_id })]
        );

        await connection.commit();
        res.redirect('/tutor/requests');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});
router.post('/tutor/request', isAuthenticated, isTutor, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { request_id, proposed_start_time, proposed_end_time, action } = req.body;
        const tutorUserId = req.session.user.id;

        if (!request_id || !action) {
            await connection.rollback();
            return res.status(400).send('Missing request ID or action.');
        }

        // 1. Fetch tutor details
        const [tutorData] = await connection.execute("SELECT id FROM tutors WHERE user_id = ?", [tutorUserId]);
        if (tutorData.length === 0) {
            await connection.rollback();
            return res.status(403).send('Tutor profile not found.');
        }
        const tutorId = tutorData[0].id;

        // 2. Validate request ownership and fetch details
        const [requests] = await connection.execute("SELECT student_id, topic FROM tutoring_requests WHERE id = ? AND tutor_id = ?", [request_id, tutorId]);
        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).send('Tutoring request not found or not authorized.');
        }
        const request = requests[0];
        
        // --- 3. EXECUTE ACTION (ACCEPT or DECLINE) ---
        let newStatus;
        let notificationType;
        let notificationMessage;

        if (action === 'accept') {
            newStatus = 'accepted';
            notificationType = 'tutor_request_accepted';
            notificationMessage = `Your tutoring request for '${request.topic}' has been accepted by ${req.session.user.name}.`;

            // Requires start/end times for scheduling
            if (!proposed_start_time || !proposed_end_time) {
                await connection.rollback();
                return res.status(400).send('Missing proposed start/end times.');
            }
            
            // Insert into sessions table
            await connection.execute(
                "INSERT INTO tutoring_sessions (request_id, start_time, end_time, status) VALUES (?, ?, ?, ?)",
                [request_id, proposed_start_time, proposed_end_time, 'scheduled']
            );
        } else if (action === 'decline') {
            newStatus = 'declined';
            notificationType = 'tutor_request_declined';
            notificationMessage = `Your tutoring request for '${request.topic}' has been declined by ${req.session.user.name}.`;
        } else {
            await connection.rollback();
            return res.status(400).send('Invalid action specified.');
        }

        // 4. Update request status
        await connection.execute("UPDATE tutoring_requests SET status = ? WHERE id = ?", [newStatus, request_id]);
        
        // 5. Create notification for the student
        await connection.execute(
            "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
            [request.student_id, notificationType, notificationMessage, `/my-tutoring-requests`]
        );

        // 6. Audit Log (Simplified)
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [tutorUserId, `tutoring_request_${newStatus}`, 'tutoring_request', request_id, JSON.stringify({ tutor_id: tutorId, student_id: request.student_id })]
        );

        await connection.commit();
        res.redirect('/tutor#requests-content'); // Redirect back to dashboard requests tab
        
    } catch (err) {
        if (connection) await connection.rollback();
        console.error("Tutoring Request Action Error:", err);
        res.status(500).send('Internal Server Error during request processing.');
    } finally {
        if (connection) connection.release();
    }
});
router.post('/tutor/requests/:id/decline', isAuthenticated, isTutor, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const requestId = req.params.id;
        const tutorUserId = req.session.user.id;

        const [tutorData] = await connection.execute("SELECT id FROM tutors WHERE user_id = ?", [tutorUserId]);
        if (tutorData.length === 0) {
            await connection.rollback();
            return res.status(403).send('Tutor profile not found.');
        }
        const tutorId = tutorData[0].id;

        // Check if the request exists and belongs to this tutor
        const [requests] = await connection.execute("SELECT * FROM tutoring_requests WHERE id = ? AND tutor_id = ?", [requestId, tutorId]);
        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).send('Tutoring request not found or not authorized.');
        }
        const request = requests[0];

        // Update request status to 'declined'
        await connection.execute("UPDATE tutoring_requests SET status = 'declined' WHERE id = ?", [requestId]);

        // Create notification for the student
        await connection.execute(
            "INSERT INTO notifications (user_id, type, message, link) VALUES (?, ?, ?, ?)",
            [request.student_id, 'tutor_request_declined', `Your tutoring request for '${request.topic}' has been declined by ${req.session.user.name}.`, `/my-tutoring-requests`]
        );

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'tutoring_request_declined', 'tutoring_request', requestId, JSON.stringify({ tutor_id: tutorId, student_id: request.student_id })]
        );

        await connection.commit();
        res.redirect('/tutor/requests');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

router.get('/tutor/sessions/:id/summary', isAuthenticated, isTutor, async (req, res) => {
    try {
        const sessionId = req.params.id;
        const tutorUserId = req.session.user.id;

        const [tutorData] = await db.execute("SELECT id FROM tutors WHERE user_id = ?", [tutorUserId]);
        if (tutorData.length === 0) {
            return res.status(403).send('Tutor profile not found.');
        }
        const tutorId = tutorData[0].id;

        // Fetch session details and verify it belongs to this tutor
        const [sessions] = await db.execute(
            `SELECT ts.*, tr.topic, u.name AS student_name
             FROM tutoring_sessions ts
             JOIN tutoring_requests tr ON ts.request_id = tr.id
             JOIN users u ON tr.student_id = u.id
             WHERE ts.id = ? AND tr.tutor_id = ?`,
            [sessionId, tutorId]
        );

        if (sessions.length === 0) {
            return res.status(404).send('Tutoring session not found or not authorized.');
        }
        const session = sessions[0];

        res.render('base', {
            mainTemplate: 'session-summary',
            session: session
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/tutor/sessions/:id/summary', isAuthenticated, isTutor, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const sessionId = req.params.id;
        const tutorUserId = req.session.user.id;
        const { tutor_notes, materials, status } = req.body; // 'materials' is a placeholder

        const [tutorData] = await connection.execute("SELECT id FROM tutors WHERE user_id = ?", [tutorUserId]);
        if (tutorData.length === 0) {
            await connection.rollback();
            return res.status(403).send('Tutor profile not found.');
        }
        const tutorId = tutorData[0].id;

        // Verify that the session belongs to this tutor
        const [sessions] = await connection.execute(
            `SELECT ts.* FROM tutoring_sessions ts
             JOIN tutoring_requests tr ON ts.request_id = tr.id
             WHERE ts.id = ? AND tr.tutor_id = ?`,
            [sessionId, tutorId]
        );

        if (sessions.length === 0) {
            await connection.rollback();
            return res.status(404).send('Tutoring session not found or not authorized.');
        }

        await connection.execute(
            "UPDATE tutoring_sessions SET tutor_notes = ?, status = ? WHERE id = ?",
            [tutor_notes, status, sessionId]
        );
        // Note: 'materials' is not stored in DB, it's a placeholder for now.

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'tutoring_session_summary_updated', 'tutoring_session', sessionId, JSON.stringify({ tutor_id: tutorId, status: status })]
        );

        await connection.commit();
        res.redirect('/tutor/requests'); // Redirect back to tutor dashboard
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

router.post('/tutor/request/:id/accept', isAuthenticated, isTutor, async (req, res) => {
    try {
        const requestId = req.params.id; // The unique ID of the tutoring request
        const tutorUserId = req.session.user.id;

        // 1. Update the request status to 'accepted'
        const [result] = await db.execute(
            "UPDATE tutoring_requests SET status = 'accepted' WHERE id = ? AND tutor_id = ?",
            [requestId, tutorUserId]
        );

        if (result.affectedRows === 0) {
            // This happens if the request ID is wrong or the request doesn't belong to this tutor
            return res.status(404).send('Request not found or not authorized to accept.');
        }

        // 2. Redirect back to the dashboard's requests tab
        res.redirect('/tutor#requests-content'); 

    } catch (err) {
        console.error("Error accepting request:", err);
        res.status(500).send('Internal Server Error while accepting request.');
    }
});

// --- Resources Routes (RSC-01, RSC-02) ---
router.get('/resources', isAuthenticated, async (req, res) => {
    try {
        const { search, course_id, page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT r.*, u.name AS publisher_name, c.title AS course_title
            FROM resources r
            JOIN users u ON r.user_id = u.id
            LEFT JOIN courses c ON r.course_id = c.id
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND (r.title LIKE ? OR r.tags LIKE ? OR r.content LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (course_id) {
            query += ` AND r.course_id = ?`;
            params.push(course_id);
        }
        query += ` ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [resources] = await db.execute(query, params);

        const [totalResources] = await db.execute(`
            SELECT COUNT(*) AS count
            FROM resources r
            JOIN users u ON r.user_id = u.id
            LEFT JOIN courses c ON r.course_id = c.id
            WHERE 1=1
            ${search ? ` AND (r.title LIKE '%${search}%' OR r.tags LIKE '%${search}%' OR r.content LIKE '%${search}%')` : ''}
            ${course_id ? ` AND r.course_id = ${course_id}` : ''}
        `);
        const totalPages = Math.ceil(totalResources[0].count / limit);

        const [courses] = await db.execute("SELECT id, title FROM courses ORDER BY title ASC");

        res.render('base', {
            mainTemplate: 'resources',
            resources: resources,
            courses: courses,
            search: search,
            course_id: course_id,
            currentPage: parseInt(page),
            totalPages: totalPages
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/resources/publish', isAuthenticated, async (req, res) => {
    // Only tutors and admins can publish resources
    if (req.session.user.role !== 'tutor' && req.session.user.role !== 'admin') {
        return res.status(403).send('Forbidden');
    }
    try {
        const [courses] = await db.execute("SELECT id, title FROM courses ORDER BY title ASC");
        res.render('base', {
            mainTemplate: 'publish-resource',
            courses: courses
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});
router.post('/tutor/resource', isAuthenticated, isTutor, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Get the data from the form
        const { resourceTitle, resourceContent } = req.body; 

        // 1. Insert the resource into the database
        await db.execute(
            "INSERT INTO resources (user_id, title, type, content) VALUES (?, ?, 'text', ?)",
            [userId, resourceTitle, resourceContent]
        );

        // 2. Redirect back to the resources tab
        res.redirect('/tutor#resources-content');
    } catch (err) {
        console.error("Error posting resource:", err);
        res.status(500).send('Internal Server Error while posting resource.');
    }
});
router.post('/resources', isAuthenticated, async (req, res) => {
    
    if (req.session.user.role !== 'tutor' && req.session.user.role !== 'admin') {
        return res.status(403).send('Forbidden');
    }
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { title, course_id, type, content, tags } = req.body;
        const userId = req.session.user.id;

        let parsedTags = null;
        if (tags) {
            parsedTags = JSON.stringify(tags.split(',').map(s => s.trim()));
        }

        await connection.execute(
            "INSERT INTO resources (user_id, course_id, title, type, content, tags) VALUES (?, ?, ?, ?, ?, ?)",
            [userId, course_id || null, title, type, content, parsedTags]
        );

        await connection.commit(); // SAFE-02: Atomic action
        res.redirect('/resources');
    } catch (err) {
        if (connection) await connection.rollback(); // SAFE-02: Atomic action
        console.error(err);
        res.status(500).send('Internal Server Error'); // SAFE-01
    } finally {
        if (connection) connection.release();
    }
});

router.post('/tutor/resource/delete', isAuthenticated, isTutor, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Get the resource_id from the hidden form field
        const resourceId = req.body.resource_id; 

        if (!resourceId) {
            return res.status(400).send('Missing resource ID.');
        }

        // CRITICAL: Delete the resource, but only if it belongs to the logged-in user (security check)
        const [result] = await db.execute(
            "DELETE FROM resources WHERE id = ? AND user_id = ?",
            [resourceId, userId]
        );

        if (result.affectedRows === 0) {
            // This happens if the resource ID is wrong or the user tried to delete someone else's resource
            return res.status(404).send('Resource not found or unauthorized to delete.');
        }

        // Redirect back to the resources tab after successful deletion
        res.redirect('/tutor#resources-content');

    } catch (err) {
        console.error("Error deleting resource:", err);
        res.status(500).send('Internal Server Error during resource deletion.');
    }
});
// --- Q&A Routes (RSC-03, RSC-04, RSC-05) ---
router.get('/qa', isAuthenticated, async (req, res) => {
    try {
        const { search, course_id, page = 1, limit = 10 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT qt.*, u.name AS creator_name, c.title AS course_title
            FROM qa_threads qt
            JOIN users u ON qt.user_id = u.id
            LEFT JOIN courses c ON qt.course_id = c.id
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            query += ` AND qt.title LIKE ?`;
            params.push(`%${search}%`);
        }
        if (course_id) {
            query += ` AND qt.course_id = ?`;
            params.push(course_id);
        }
        query += ` ORDER BY qt.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [qaThreads] = await db.execute(query, params);

        const [totalThreads] = await db.execute(`
            SELECT COUNT(*) AS count
            FROM qa_threads qt
            JOIN users u ON qt.user_id = u.id
            LEFT JOIN courses c ON qt.course_id = c.id
            WHERE 1=1
            ${search ? ` AND qt.title LIKE '%${search}%'` : ''}
            ${course_id ? ` AND qt.course_id = ${course_id}` : ''}
        `);
        const totalPages = Math.ceil(totalThreads[0].count / limit);

        const [courses] = await db.execute("SELECT id, title FROM courses ORDER BY title ASC");

        res.render('base', {
            mainTemplate: 'qa-threads',
            qaThreads: qaThreads,
            courses: courses,
            search: search,
            course_id: course_id,
            currentPage: parseInt(page),
            totalPages: totalPages
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.get('/qa/create', isAuthenticated, async (req, res) => {
    try {
        const [courses] = await db.execute("SELECT id, title FROM courses ORDER BY title ASC");
        res.render('base', {
            mainTemplate: 'create-qa-thread',
            courses: courses
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/qa/threads', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { title, course_id, content } = req.body;
        const userId = req.session.user.id;

        const [result] = await connection.execute(
            "INSERT INTO qa_threads (user_id, course_id, title) VALUES (?, ?, ?)",
            [userId, course_id || null, title]
        );
        const threadId = result.insertId;

        await connection.execute(
            "INSERT INTO qa_posts (thread_id, user_id, content) VALUES (?, ?, ?)",
            [threadId, userId, content]
        );

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'qa_thread_created', 'qa_thread', threadId, JSON.stringify({ title: title, course_id: course_id })]
        );

        await connection.commit();
        res.redirect(`/qa/threads/${threadId}`);
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

router.get('/qa/threads/:id', isAuthenticated, async (req, res) => {
    try {
        const threadId = req.params.id;
        const [threads] = await db.execute(
            `SELECT qt.*, u.name AS creator_name, c.title AS course_title
             FROM qa_threads qt
             JOIN users u ON qt.user_id = u.id
             LEFT JOIN courses c ON qt.course_id = c.id
             WHERE qt.id = ?`,
            [threadId]
        );
        if (threads.length === 0) {
            return res.status(404).send('Q&A Thread not found.');
        }
        const thread = threads[0];

        const [posts] = await db.execute(
            `SELECT qp.*, u.name AS poster_name
             FROM qa_posts qp
             JOIN users u ON qp.user_id = u.id
             WHERE qp.thread_id = ?
             ORDER BY qp.created_at ASC`,
            [threadId]
        );

        res.render('base', {
            mainTemplate: 'qa-thread-detail',
            thread: thread,
            posts: posts
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/qa/threads/:id/reply', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const threadId = req.params.id;
        const userId = req.session.user.id;
        const { content } = req.body;

        await connection.execute(
            "INSERT INTO qa_posts (thread_id, user_id, content) VALUES (?, ?, ?)",
            [threadId, userId, content]
        );

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'qa_post_created', 'qa_post', threadId, JSON.stringify({ thread_id: threadId, user_id: userId })]
        );

        await connection.commit();
        res.redirect(`/qa/threads/${threadId}`);
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

router.post('/report/:type/:id', isAuthenticated, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const { type, id } = req.params; // type: 'thread' or 'post'
        const reporterId = req.session.user.id;
        const { reason } = req.body; // Optional reason from a form, or default

        if (type !== 'thread' && type !== 'post') {
            await connection.rollback();
            return res.status(400).send('Invalid content type for reporting.');
        }

        // Check if content exists (optional, but good practice)
        if (type === 'thread') {
            const [threads] = await connection.execute("SELECT id FROM qa_threads WHERE id = ?", [id]);
            if (threads.length === 0) {
                await connection.rollback();
                return res.status(404).send('Thread not found.');
            }
        } else { // type === 'post'
            const [posts] = await connection.execute("SELECT id FROM qa_posts WHERE id = ?", [id]);
            if (posts.length === 0) {
                await connection.rollback();
                return res.status(404).send('Post not found.');
            }
        }

        await connection.execute(
            "INSERT INTO reported_content (reporter_id, content_type, content_id, reason) VALUES (?, ?, ?, ?)",
            [reporterId, type, id, reason || 'No reason provided']
        );

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'content_reported', 'reported_content', id, JSON.stringify({ content_type: type, reporter_id: reporterId, reason: reason })]
        );

        await connection.commit();
        res.redirect('back'); // Redirect back to the previous page
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

// --- Notification Routes (NOT-01, NOT-02) ---
router.get('/notifications', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const [notifications] = await db.execute(
            "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC",
            [userId]
        );
        res.render('base', {
            mainTemplate: 'notifications',
            notifications: notifications
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/notifications/:id/mark-read', isAuthenticated, async (req, res) => {
    try {
        const notificationId = req.params.id;
        const userId = req.session.user.id;
        await db.execute("UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?", [notificationId, userId]);
        res.redirect('back');
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

router.post('/notifications/mark-all-read', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        await db.execute("UPDATE notifications SET is_read = TRUE WHERE user_id = ?", [userId]);
        res.redirect('back');
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

// --- Admin Routes (ADM-01, ADM-02, ADM-04, ADM-05) ---
router.get('/admin/dashboard', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 10 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        // ADM-01: Fetch unapproved tutors
        let unapprovedTutorsQuery = `
            SELECT t.id, u.name, u.email, t.bio, t.subjects, t.hourly_rate
             FROM tutors t
             JOIN users u ON t.user_id = u.id
             WHERE t.is_approved = FALSE
        `;
        const [totalUnapprovedTutors] = await db.execute(`SELECT COUNT(*) AS count FROM tutors WHERE is_approved = FALSE`);
        const totalUnapprovedTutorPages = Math.ceil(totalUnapprovedTutors[0].count / parseInt(limit));
        unapprovedTutorsQuery += ` LIMIT ? OFFSET ?`;
        const [unapprovedTutors] = await db.execute(unapprovedTutorsQuery, [parseInt(limit), parseInt(offset)]);

        // ADM-02: Fetch reported content
        let reportedContentQuery = `
            SELECT rc.*, u.name AS reporter_name, qt.title AS thread_title
             FROM reported_content rc
             JOIN users u ON rc.reporter_id = u.id
             LEFT JOIN qa_threads qt ON rc.content_type = 'thread' AND rc.content_id = qt.id
             WHERE rc.status = 'pending'
        `;
        const [totalReportedContent] = await db.execute(`SELECT COUNT(*) AS count FROM reported_content WHERE status = 'pending'`);
        const totalReportedContentPages = Math.ceil(totalReportedContent[0].count / parseInt(limit));
        reportedContentQuery += ` LIMIT ? OFFSET ?`;
        const [reportedContent] = await db.execute(reportedContentQuery, [parseInt(limit), parseInt(offset)]);

        // ADM-04: Fetch all users for management
        let allUsersQuery = `SELECT id, name, email, role, status FROM users`;
        const [totalUsers] = await db.execute(`SELECT COUNT(*) AS count FROM users`);
        const totalUserPages = Math.ceil(totalUsers[0].count / parseInt(limit));
        allUsersQuery += ` ORDER BY name ASC LIMIT ? OFFSET ?`;
        const [allUsers] = await db.execute(allUsersQuery, [parseInt(limit), parseInt(offset)]);

        res.render('base', {
            mainTemplate: 'admin-dashboard',
            unapprovedTutors: unapprovedTutors,
            reportedContent: reportedContent,
            allUsers: allUsers,
            currentUnapprovedTutorPage: parseInt(page),
            totalUnapprovedTutorPages: totalUnapprovedTutorPages,
            currentReportedContentPage: parseInt(page),
            totalReportedContentPages: totalReportedContentPages,
            currentUserPage: parseInt(page),
            totalUserPages: totalUserPages
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
    }
});

// ADM-01: Approve Tutor Profile
router.post('/admin/tutors/:id/approve', isAuthenticated, isAdmin, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const tutorId = req.params.id;
        await connection.execute("UPDATE tutors SET is_approved = TRUE WHERE id = ?", [tutorId]);

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'tutor_approved', 'tutor', tutorId, JSON.stringify({ approved_by: req.session.user.name })]
        );

        await connection.commit();
        res.redirect('/admin/dashboard');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

// ADM-01: Reject Tutor Profile
router.post('/admin/tutors/:id/reject', isAuthenticated, isAdmin, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const tutorId = req.params.id;
        // Optionally, delete the tutor profile or mark it as rejected
        await connection.execute("DELETE FROM tutors WHERE id = ?", [tutorId]); // For simplicity, delete

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'tutor_rejected', 'tutor', tutorId, JSON.stringify({ rejected_by: req.session.user.name })]
        );

        await connection.commit();
        res.redirect('/admin/dashboard');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

// ADM-02: Moderate Reported Content - Resolve
router.post('/admin/moderate/:id/resolve', isAuthenticated, isAdmin, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const reportId = req.params.id;
        await connection.execute("UPDATE reported_content SET status = 'resolved' WHERE id = ?", [reportId]);

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'content_resolved', 'reported_content', reportId, JSON.stringify({ resolved_by: req.session.user.name })]
        );

        await connection.commit();
        res.redirect('/admin/dashboard');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

// ADM-02: Moderate Reported Content - Dismiss
router.post('/admin/moderate/:id/dismiss', isAuthenticated, isAdmin, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const reportId = req.params.id;
        await connection.execute("UPDATE reported_content SET status = 'reviewed' WHERE id = ?", [reportId]); // Mark as reviewed/dismissed

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'content_dismissed', 'reported_content', reportId, JSON.stringify({ dismissed_by: req.session.user.name })]
        );

        await connection.commit();
        res.redirect('/admin/dashboard');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

// ADM-04: Suspend User
router.post('/admin/users/:id/suspend', isAuthenticated, isAdmin, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const userId = req.params.id;
        await connection.execute("UPDATE users SET status = 'suspended' WHERE id = ?", [userId]);

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'user_suspended', 'user', userId, JSON.stringify({ suspended_by: req.session.user.name })]
        );

        await connection.commit();
        res.redirect('/admin/dashboard');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});

// ADM-04: Activate User
router.post('/admin/users/:id/activate', isAuthenticated, isAdmin, async (req, res) => {
    let connection;
    try {
        connection = await db.getConnection();
        await connection.beginTransaction();

        const userId = req.params.id;
        await connection.execute("UPDATE users SET status = 'active' WHERE id = ?", [userId]);

        // ADM-05: Audit Log
        await connection.execute(
            "INSERT INTO audit_logs (admin_id, action_type, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, 'user_activated', 'user', userId, JSON.stringify({ activated_by: req.session.user.name })]
        );

        await connection.commit();
        res.redirect('/admin/dashboard');
    } catch (err) {
        if (connection) await connection.rollback();
        console.error(err);
        res.status(500).send('Internal Server Error');
    } finally {
        if (connection) connection.release();
    }
});


module.exports = router;
