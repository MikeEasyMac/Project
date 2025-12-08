const express = require('express');
const router = express.Router();
const db = require('../config/db');
const path = require('path');
const ejs = require('ejs');
const bcrypt = require('bcrypt'); // Add this line

// Enable JSON Parsing
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// --- HELPER: Create Notification ---
async function createNotification(userId, type, message, link) {
    if (!userId) return;
    try {
        await db.query(
            "INSERT INTO notifications (user_id, type, message, link, is_read) VALUES (?, ?, ?, ?, 0)",
            [userId, type, message, link || null]
        );
    } catch (err) { console.error("Notification Error:", err); }
}

// --- HELPER: Audit Log ---
async function logAdminAction(adminId, action) {
    try {
        await db.query("INSERT INTO audit_logs (admin_id, action) VALUES (?, ?)", [adminId, action]);
    } catch (err) { console.error("Audit Error:", err); }
}

// --- MIDDLEWARE ---
const isAuthenticated = async (req, res, next) => {
    if (req.session.user) {
        try {
            const [rows] = await db.query("SELECT status, role FROM users WHERE id = ?", [req.session.user.id]);
            if (rows.length === 0 || rows[0].status === 'suspended') {
                return req.session.destroy(() => { res.redirect('/login?error=suspended'); });
            }
            req.session.user.role = rows[0].role;
            return next();
        } catch (err) { return res.redirect('/login'); }
    }
    res.redirect('/login');
};

const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).send('Forbidden');
};

const isTutor = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'tutor') return next();
    res.status(403).send('Forbidden');
};

const isStudent = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'student') return next();
    res.status(403).send('Forbidden');
};
// ============================================================================
// 1. AUTHENTICATION (LOGIN / SIGNUP)
// ============================================================================
router.get('/login', (req, res) => { 
    res.render('login'); 
});

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
        
        if (users.length === 0) return res.redirect('/login?error=invalid');

        // SECURITY FIX: Compare the typed password with the hashed password in DB
        const match = await bcrypt.compare(password, users[0].password);

        if (!match) {
            return res.redirect('/login?error=invalid');
        }

        // Check Status
        if (users[0].status === 'suspended') {
            return res.send('<h3>Account Suspended. Contact Admin.</h3>');
        }

        // Check Tutor Approval
        if (users[0].role === 'tutor') {
            const [tutor] = await db.query("SELECT is_approved FROM tutors WHERE user_id = ?", [users[0].id]);
            if (tutor.length > 0 && !tutor[0].is_approved) return res.send('<h3>Account Pending Approval.</h3>');
        }

        req.session.user = users[0];
        res.redirect('/');
    } catch (err) { console.error(err); res.redirect('/login'); }
});

// GET SIGNUP ROUTE (MISSING ROUTE HANDLER)
router.get('/signup', async (req, res) => {
    try {
        // We pass courses=[] and error=null variables for the view
        res.render('signup', { courses: [], error: null }); 
    } catch (err) { 
        console.error("GET Signup Error:", err);
        // Fallback render to prevent crash if ejs template lookup fails
        res.status(500).send("Server Error loading signup page."); 
    }
});

router.post('/signup', async (req, res) => {
    try {
        const { email, name, password, role, bio, preferred_course_title, hourly_rate } = req.body; 
        
        // 1. Check if user already exists (Prevents silent crash on UNIQUE constraint)
        const [existingUser] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
        if (existingUser.length > 0) {
            // Render signup page again with specific error message
            return res.render('signup', { 
                error: "This email address is already registered. Please log in.",
                courses: [] // Pass courses=[] to keep the EJS view happy
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // 2. Create User
        const [result] = await db.query("INSERT INTO users (email, name, password, role, status) VALUES (?, ?, ?, ?, 'active')", [email, name, hashedPassword, role]);
        const userId = result.insertId;

        // 3. Handle Tutor Flow
        if (role === 'tutor') {
            // ... (rest of tutor logic for subjects, bio, rate) ...
            const subjectString = JSON.stringify([preferred_course_title || 'General']); 
            
            await db.query("INSERT INTO tutors (user_id, bio, subjects, hourly_rate, is_approved) VALUES (?, ?, ?, ?, 0)", 
                [userId, bio || null, subjectString, hourly_rate || 0]);
            
            // Tutor Success Page
            return res.render('base', { body: `<div class='container mt-5 text-center'><h2>Registration Successful!</h2><p>Your account is pending admin approval for ${preferred_course_title || 'a general subject'}.</p><a href='/login' class='btn btn-primary'>Back to Login</a></div>` });
        }

        // 4. Handle Student Flow Success
        res.redirect('/login');

    } catch (err) { 
        console.error("Signup Error:", err); 
        // Catch any other critical DB errors (like missing table)
        return res.render('signup', { 
            error: "A critical server error occurred. Check server logs.", 
            courses: [] 
        });
    }
});

// ============================================================================
// 2. MAIN DASHBOARD
// ============================================================================
router.get('/', isAuthenticated, async (req, res) => {
    try {
        if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
        if (req.session.user.role === 'tutor') return res.redirect('/tutor/dashboard');

        const userId = req.session.user.id;
        
        let totalUsers = 0;
        if (req.session.user.role === 'admin') {
            const [rows] = await db.query("SELECT COUNT(*) AS count FROM users");
            totalUsers = rows[0].count;
        }

        // Fix Todo Count
        const [items] = await db.query("SELECT id, title, done FROM todos WHERE user_id = ? ORDER BY id DESC LIMIT 50", [userId]);
        const activeTodos = items.filter(item => !item.done).length;

        const [upcomingAssignments] = await db.query(
            `SELECT a.id, a.title, a.due_date, a.status, c.title AS course_title
             FROM assignments a
             JOIN courses c ON a.course_id = c.id
             JOIN enrollments e ON a.course_id = e.course_id AND a.user_id = e.user_id
             WHERE a.user_id = ? ORDER BY a.due_date ASC`, [userId]);

        const [upcomingStudySessions] = await db.query(
            `SELECT ss.title, ss.start_time, ss.end_time, a.title AS assignment_title
             FROM study_sessions ss
             LEFT JOIN assignments a ON ss.assignment_id = a.id
             WHERE ss.user_id = ? AND ss.status = 'planned' AND ss.start_time > NOW()
             ORDER BY ss.start_time ASC LIMIT 5`, [userId]);

        res.render('base', {
            body: await ejs.renderFile(path.join(__dirname, '../views', 'index.ejs'), {
                users: totalUsers,
                todos: activeTodos,
                items: items,
                upcomingAssignments: upcomingAssignments,
                upcomingStudySessions: upcomingStudySessions,
                user: req.session.user
            })
        });
    } catch (err) { console.error(err); res.status(500).send('Internal Server Error'); }
});

// --- TODO ROUTES ---
router.post('/todo', isAuthenticated, async (req, res) => {
    try {
        const title = req.body.title ? req.body.title.trim() : '';
        if (title) {
            const [result] = await db.query("INSERT INTO todos(user_id, title, done) VALUES (?, ?, 0)", [req.session.user.id, title]);
            const [rows] = await db.query("SELECT * FROM todos WHERE id = ?", [result.insertId]);
            return res.json(rows[0]);
        }
        return res.status(400).json({ error: 'Title required' });
    } catch (err) { console.error(err); res.status(500).send('Server Error'); }
});

router.post('/todo/:id/toggle', isAuthenticated, async (req, res) => {
    try {
        await db.query("UPDATE todos SET done = NOT done WHERE id = ? AND user_id = ?", [req.params.id, req.session.user.id]);
        res.redirect('/');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/todo/:id/delete', isAuthenticated, async (req, res) => {
    try {
        await db.query("DELETE FROM todos WHERE id = ? AND user_id = ?", [req.params.id, req.session.user.id]);
        res.redirect('/');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

// ============================================================================
// 3. STUDENT ROUTES
// ============================================================================

// --- STUDY SESSIONS ---
router.get('/study-sessions', isAuthenticated, async (req, res) => {
    try {
        const [sessions] = await db.query(
            `SELECT ss.id, ss.title, ss.start_time, ss.end_time, ss.status, a.title AS assignment_title
             FROM study_sessions ss
             LEFT JOIN assignments a ON ss.assignment_id = a.id
             WHERE ss.user_id = ?
             ORDER BY ss.start_time DESC`,
            [req.session.user.id]
        );
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'study-sessions.ejs'), { studySessions: sessions, user: req.session.user }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/study-sessions/add', isAuthenticated, async (req, res) => {
    try {
        const [assignments] = await db.query("SELECT id, title FROM assignments WHERE user_id = ? ORDER BY due_date DESC", [req.session.user.id]);
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'add-study-session.ejs'), { assignments, user: req.session.user }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/study-sessions', isAuthenticated, async (req, res) => {
    try {
        const { title, assignment_id, start_time, end_time, notes } = req.body;
        await db.query("INSERT INTO study_sessions (user_id, title, assignment_id, start_time, end_time, notes) VALUES (?, ?, ?, ?, ?, ?)", 
            [req.session.user.id, title, assignment_id || null, start_time, end_time, notes]);
        res.redirect('/study-sessions');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/study-sessions/generate', isAuthenticated, async (req, res) => {
    try {
        const { assignment_id, total_hours } = req.body;
        const [assignData] = await db.query("SELECT title, due_date FROM assignments WHERE id = ?", [assignment_id]);
        if (assignData.length === 0) return res.redirect('/study-sessions/add');
        
        const dueDate = new Date(assignData[0].due_date);
        const today = new Date();
        let days = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
        if (days < 1) days = 1;

        for (let i = 0; i < total_hours; i++) {
            let d = new Date(); d.setDate(today.getDate() + (i % days)); d.setHours(18 + Math.floor(i / days), 0, 0);
            let end = new Date(d); end.setHours(d.getHours() + 1);
            await db.query("INSERT INTO study_sessions (user_id, title, assignment_id, start_time, end_time, status, notes) VALUES (?, ?, ?, ?, ?, 'planned', ?)", 
                [req.session.user.id, `Study ${assignData[0].title}`, assignment_id, d, end, `Auto-gen ${i+1}`]);
        }
        res.redirect('/study-sessions');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/study-sessions/:id/status', isAuthenticated, async (req, res) => {
    try {
        await db.query("UPDATE study_sessions SET status = ? WHERE id = ? AND user_id = ?", 
            [req.body.status, req.params.id, req.session.user.id]);
        res.redirect('/study-sessions');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/study-sessions/:id/delete', isAuthenticated, async (req, res) => {
    try {
        await db.query("DELETE FROM study_sessions WHERE id = ? AND user_id = ?", [req.params.id, req.session.user.id]);
        res.redirect('/study-sessions');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

// --- TUTORING REQUESTS ---
router.get('/my-tutoring-requests', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        let requests = [];
        if (req.session.user.role === 'student') {
            [requests] = await db.execute(
                `SELECT tr.id, tr.topic, tr.details, tr.status, tr.created_at, 
                        u.name as tutor_name, ta.start_time, ta.end_time 
                 FROM tutoring_requests tr 
                 JOIN tutors t ON tr.tutor_id = t.id 
                 JOIN users u ON t.user_id = u.id 
                 LEFT JOIN tutor_availability ta ON tr.preferred_time_windows = ta.id 
                 WHERE tr.student_id = ? ORDER BY tr.created_at DESC`, [userId]);
        } else {
            [requests] = await db.execute(
                `SELECT tr.id, tr.topic, tr.details, tr.status, tr.created_at, 
                        u.name as student_name, ta.start_time, ta.end_time 
                 FROM tutoring_requests tr 
                 JOIN users u ON tr.student_id = u.id 
                 JOIN tutors t ON tr.tutor_id = t.id 
                 LEFT JOIN tutor_availability ta ON tr.preferred_time_windows = ta.id 
                 WHERE t.user_id = ? ORDER BY tr.created_at DESC`, [userId]);
        }
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'my-tutoring-requests.ejs'), { tutoringRequests: requests, user: req.session.user }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/tutoring-requests/:id/cancel', isAuthenticated, async (req, res) => {
    try {
        await db.query("UPDATE tutoring_requests SET status = 'cancelled' WHERE id = ?", [req.params.id]);
        const [reqInfo] = await db.query("SELECT preferred_time_windows, tutor_id, topic FROM tutoring_requests WHERE id = ?", [req.params.id]);
        if (reqInfo.length > 0 && reqInfo[0].preferred_time_windows) {
             await db.query("UPDATE tutor_availability SET is_booked = 0 WHERE id = ?", [reqInfo[0].preferred_time_windows]);
             const [tutorUser] = await db.query("SELECT user_id FROM tutors WHERE id = ?", [reqInfo[0].tutor_id]);
             if(tutorUser.length > 0) {
                 await createNotification(tutorUser[0].user_id, 'request', `Session cancelled: '${reqInfo[0].topic}'`, '/tutor/dashboard');
             }
        }
        res.redirect('/my-tutoring-requests');
    } catch (err) { console.error(err); res.redirect('/my-tutoring-requests'); }
});

// --- COURSES & ASSIGNMENTS ---
router.get('/courses', isAuthenticated, async (req, res) => {
    try {
        const [courses] = await db.query("SELECT * FROM courses ORDER BY id DESC");
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'courses.ejs'), { courses, flash: req.session.flash || null }) });
        req.session.flash = null;
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/courses/:courseId/enroll', isAuthenticated, async (req, res) => {
    try {
        const [check] = await db.query("SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?", [req.session.user.id, req.params.courseId]);
        if (check.length === 0) {
            await db.query("INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)", [req.session.user.id, req.params.courseId]);
            const [course] = await db.query("SELECT title FROM courses WHERE id = ?", [req.params.courseId]);
            await createNotification(req.session.user.id, 'course', `You enrolled in ${course[0].title}.`, '/my-courses');
            req.session.flash = { type: 'success', message: 'Enrolled!' };
        }
        res.redirect('/courses');
    } catch (err) { console.error(err); res.redirect('/courses'); }
});

router.post('/courses/:courseId/withdraw', isAuthenticated, async (req, res) => {
    try {
        await db.query("DELETE FROM enrollments WHERE user_id = ? AND course_id = ?", [req.session.user.id, req.params.courseId]);
        res.redirect('/my-courses');
    } catch (err) { console.error(err); res.redirect('/my-courses'); }
});

router.get('/my-courses', isAuthenticated, async (req, res) => {
    try {
        const [courses] = await db.query(`SELECT c.id, c.code, c.title FROM courses c JOIN enrollments e ON c.id = e.course_id WHERE e.user_id = ?`, [req.session.user.id]);
        for (let course of courses) {
            const [assign] = await db.query("SELECT * FROM assignments WHERE course_id = ? AND user_id = ? ORDER BY due_date ASC", [course.id, req.session.user.id]);
            course.assignments = assign;
        }
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'my-courses.ejs'), { courses, user: req.session.user, flash: null }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/my-assignments', isAuthenticated, isStudent, async (req, res) => {
    try {
        const [pending] = await db.query(
            `SELECT a.id, a.title, a.due_date, c.title AS course_title 
             FROM assignments a 
             JOIN courses c ON a.course_id = c.id 
             JOIN enrollments e ON a.course_id = e.course_id AND a.user_id = e.user_id
             WHERE a.user_id = ? AND a.status = 'pending' ORDER BY a.due_date ASC`, 
            [req.session.user.id]
        );
        const [completed] = await db.query(
            `SELECT a.id, a.title, a.grade, a.tutor_feedback, c.title AS course_title 
             FROM assignments a 
             JOIN courses c ON a.course_id = c.id 
             JOIN enrollments e ON a.course_id = e.course_id AND a.user_id = e.user_id
             WHERE a.user_id = ? AND a.status = 'completed' ORDER BY a.submitted_at DESC`, 
            [req.session.user.id]
        );
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'student-assignments.ejs'), { pending, completed }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/assignments/:id', isAuthenticated, isStudent, async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT a.*, c.title AS course_title FROM assignments a JOIN courses c ON a.course_id = c.id WHERE a.id = ? AND a.user_id = ?`, [req.params.id, req.session.user.id]);
        if (rows.length === 0) return res.redirect('/my-assignments');
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'do-assignment.ejs'), { assignment: rows[0] }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/assignments/:id/submit', isAuthenticated, isStudent, async (req, res) => {
    try {
        await db.query("UPDATE assignments SET submission_text = ?, status = 'completed', submitted_at = NOW() WHERE id = ? AND user_id = ?", [req.body.submission_text, req.params.id, req.session.user.id]);
        res.redirect('/my-assignments');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

// ============================================================================
// 4. TUTOR DASHBOARD
// ============================================================================
router.get('/tutor/dashboard', isAuthenticated, isTutor, async (req, res) => {
    try {
        const [tutors] = await db.query("SELECT id FROM tutors WHERE user_id = ?", [req.session.user.id]);
        if (tutors.length === 0) return res.status(403).send('Tutor profile missing');
        const tutorId = tutors[0].id;

        const [courses] = await db.query("SELECT c.id, c.title FROM courses c JOIN tutor_courses tc ON c.id = tc.course_id WHERE tc.tutor_id = ?", [tutorId]);
        for(let c of courses) {
            const [s] = await db.query("SELECT u.name FROM users u JOIN enrollments e ON u.id = e.user_id WHERE e.course_id = ?", [c.id]);
            c.students = s;
        }
        
        // Show all appointments for today & future
        const [appts] = await db.query(
            `SELECT tr.topic, tr.details, u.name AS student_name, u.email AS student_email, ta.start_time, ta.end_time 
             FROM tutoring_requests tr 
             JOIN tutor_availability ta ON tr.preferred_time_windows = ta.id 
             JOIN users u ON tr.student_id = u.id 
             WHERE tr.tutor_id = ? 
             AND ta.is_booked = 1 
             AND tr.status != 'cancelled' 
             AND ta.end_time >= CURDATE()
             ORDER BY ta.start_time ASC`, [tutorId]);

        const [postedAssignments] = await db.query(
            `SELECT MAX(a.id) as id, a.title, a.due_date, c.title AS course_title, 
             SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as submission_count
             FROM assignments a
             JOIN courses c ON a.course_id = c.id
             JOIN tutor_courses tc ON c.id = tc.course_id
             WHERE tc.tutor_id = ?
             GROUP BY a.title, a.due_date, c.title
             ORDER BY a.due_date DESC`, 
             [tutorId]
        );
        
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'tutor-dashboard.ejs'), { courses, upcomingAppointments: appts, postedAssignments, user: req.session.user }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/tutor/create-assignment', isAuthenticated, isTutor, async (req, res) => {
    try {
        const { course_id, title, due_date, description } = req.body;
        const [students] = await db.query("SELECT user_id FROM enrollments WHERE course_id = ?", [course_id]);
        const [course] = await db.query("SELECT title FROM courses WHERE id = ?", [course_id]);

        for (const s of students) {
            await db.query("INSERT INTO assignments (user_id, course_id, title, due_date, description, status) VALUES (?, ?, ?, ?, ?, 'pending')", 
                [s.user_id, course_id, title, new Date(due_date), description]);
            
            await createNotification(s.user_id, 'assignment', `New assignment posted in ${course[0].title}: ${title}`, '/my-assignments');
        }
        res.redirect('/tutor/dashboard');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/tutors', isAuthenticated, async (req, res) => {
    try {
        const [tutors] = await db.query("SELECT t.id, u.name, t.bio, t.subjects, t.hourly_rate FROM tutors t JOIN users u ON t.user_id = u.id");
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'tutors.ejs'), { tutors }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/tutor/grading', isAuthenticated, isTutor, async (req, res) => {
    try {
        const [subs] = await db.query(`SELECT a.id, a.title, a.submission_text, a.submitted_at, u.name AS student_name FROM assignments a JOIN users u ON a.user_id = u.id JOIN tutor_courses tc ON a.course_id = tc.course_id JOIN tutors t ON tc.tutor_id = t.id WHERE t.user_id = ? AND a.status = 'completed' AND a.grade IS NULL`, [req.session.user.id]);
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'tutor-grading.ejs'), { submissions: subs }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/tutor/assignments/:id/grade', isAuthenticated, isTutor, async (req, res) => {
    try {
        await db.query("UPDATE assignments SET grade = ?, tutor_feedback = ? WHERE id = ?", [req.body.grade, req.body.feedback, req.params.id]);
        const [assign] = await db.query("SELECT title, user_id FROM assignments WHERE id = ?", [req.params.id]);
        await createNotification(assign[0].user_id, 'grade', `Your assignment "${assign[0].title}" has been graded.`, '/my-assignments');
        res.redirect('/tutor/grading');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/tutor/availability', isAuthenticated, isTutor, async (req, res) => {
    try {
        const [tutors] = await db.query("SELECT id FROM tutors WHERE user_id = ?", [req.session.user.id]);
        if (tutors.length === 0) return res.status(403).send('Tutor profile not found.');
        
        // Auto-Clean old slots
        await db.query("DELETE FROM tutor_availability WHERE end_time < NOW()");
        
        const [availability] = await db.query("SELECT * FROM tutor_availability WHERE tutor_id = ? ORDER BY start_time", [tutors[0].id]);
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'tutor-availability.ejs'), { availability }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/tutor/availability', isAuthenticated, isTutor, async (req, res) => {
    try {
        const [tutors] = await db.query("SELECT id FROM tutors WHERE user_id = ?", [req.session.user.id]);
        const { date, start_time, end_time } = req.body;
        await db.query("INSERT INTO tutor_availability (tutor_id, start_time, end_time) VALUES (?, ?, ?)", [tutors[0].id, new Date(`${date}T${start_time}`), new Date(`${date}T${end_time}`)]);
        res.redirect('/tutor/availability');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.delete('/tutor/availability/:id', isAuthenticated, isTutor, async (req, res) => {
    try {
        const [tutors] = await db.query("SELECT id FROM tutors WHERE user_id = ?", [req.session.user.id]);
        await db.query("DELETE FROM tutor_availability WHERE id = ? AND tutor_id = ?", [req.params.id, tutors[0].id]);
        res.redirect('/tutor/availability');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/tutors/:id/request', isAuthenticated, async (req, res) => {
    try {
        const [tutors] = await db.query(`SELECT t.id, u.name FROM tutors t JOIN users u ON t.user_id = u.id WHERE t.id = ?`, [req.params.id]);
        if (tutors.length === 0) return res.status(404).send('Tutor not found');
        
        // Auto-Clean old slots before showing
        await db.query("DELETE FROM tutor_availability WHERE tutor_id = ? AND end_time < NOW()", [req.params.id]);
        
        const [availability] = await db.query("SELECT * FROM tutor_availability WHERE tutor_id = ? AND is_booked = 0 AND start_time > NOW() ORDER BY start_time", [req.params.id]);
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'request-tutoring.ejs'), { tutor: tutors[0], availability }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/tutors/:id/request', isAuthenticated, async (req, res) => {
    try {
        const { topic, availability_slot, details } = req.body;
        await db.query("UPDATE tutor_availability SET is_booked = 1 WHERE id = ?", [availability_slot]);
        await db.query("INSERT INTO tutoring_requests (student_id, tutor_id, topic, details, preferred_time_windows) VALUES (?, ?, ?, ?, ?)",
            [req.session.user.id, req.params.id, topic, details, availability_slot]);
        
        const [tutorUser] = await db.query("SELECT user_id FROM tutors WHERE id = ?", [req.params.id]);
        if(tutorUser.length > 0) await createNotification(tutorUser[0].user_id, 'request', `New request: ${topic}`, '/tutor/dashboard');
        await createNotification(req.session.user.id, 'request', `Requested session: ${topic}`, '/my-tutoring-requests');

        res.redirect('/my-tutoring-requests');
    } catch (err) { console.error(err); res.redirect('/tutors'); }
});

// --- RESOURCES & PUBLISH ---
router.get('/resources', isAuthenticated, async (req, res) => {
    try {
        const { search, course_id } = req.query;
        let query = `SELECT r.id, r.title, r.type, r.content, r.tags, u.name AS publisher_name, c.title AS course_title FROM resources r JOIN users u ON r.user_id = u.id LEFT JOIN courses c ON r.course_id = c.id WHERE 1=1`;
        const params = [];
        if (search) { query += ' AND (r.title LIKE ? OR r.tags LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
        if (course_id) { query += ' AND r.course_id = ?'; params.push(course_id); }
        query += ' ORDER BY r.created_at DESC';
        const [resources] = await db.query(query, params);
        const [courses] = await db.query("SELECT * FROM courses ORDER BY title");
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'resources.ejs'), { resources, courses, search: search||'', course_id: course_id||'', user: req.session.user }) });
    } catch (err) { res.status(500).send('Error'); }
});

router.get('/resources/publish', isAuthenticated, async (req, res) => {
    try {
        if (req.session.user.role !== 'tutor' && req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
        const userId = req.session.user.id;
        let courses = [];
        if (req.session.user.role === 'admin') {
            [courses] = await db.query("SELECT * FROM courses ORDER BY title");
        } else {
            [courses] = await db.query(`SELECT c.id, c.title FROM courses c JOIN tutor_courses tc ON c.id = tc.course_id JOIN tutors t ON tc.tutor_id = t.id WHERE t.user_id = ? ORDER BY c.title`, [userId]);
        }
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'publish-resource.ejs'), { courses, user: req.session.user }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/resources', isAuthenticated, async (req, res) => {
    try {
        await db.query("INSERT INTO resources (user_id, course_id, title, type, content, tags) VALUES (?, ?, ?, ?, ?, ?)", 
            [req.session.user.id, req.body.course_id, req.body.title, req.body.type, req.body.content, req.body.tags]);
        
        const [students] = await db.query("SELECT user_id FROM enrollments WHERE course_id = ?", [req.body.course_id]);
        for (const s of students) {
            await createNotification(s.user_id, 'resource', `New resource: ${req.body.title}`, '/resources');
        }
        res.redirect('/resources');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

// --- ADMIN ---
// --- ADMIN DASHBOARD ---
router.get('/admin/dashboard', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [userCount] = await db.query("SELECT COUNT(*) as c FROM users");
        const [sessionCount] = await db.query("SELECT COUNT(*) as c FROM tutoring_sessions WHERE status='scheduled'");
        const [tutorCount] = await db.query("SELECT COUNT(*) as c FROM tutors WHERE is_approved=0");
        const [resCount] = await db.query("SELECT COUNT(*) as c FROM resources");

        // Fetch Pending Tutors (READS REQUESTED COURSE TITLE FROM 'subjects' COLUMN)
        const [unapprovedTutors] = await db.query(`
            SELECT t.id, t.user_id, u.name, u.email, t.subjects, t.hourly_rate 
            FROM tutors t 
            JOIN users u ON t.user_id = u.id 
            WHERE t.is_approved = 0
        `);

        // Format subjects array for cleaner display
        unapprovedTutors.forEach(t => {
            try {
                // Parse the JSON array and use the first element as the requested course
                const subjectsArray = JSON.parse(t.subjects);
                t.requested_course = subjectsArray[0] || 'Unspecified';
            } catch (e) {
                // If JSON fails (e.g., old data), use the raw string
                t.requested_course = t.subjects || 'Unspecified'; 
            }
        });

        const [allUsers] = await db.query("SELECT id, name, email, role, status FROM users ORDER BY id DESC LIMIT 50");
        const [recentResources] = await db.query("SELECT r.id, r.title, u.name as publisher_name FROM resources r JOIN users u ON r.user_id = u.id ORDER BY r.created_at DESC LIMIT 10");
        const [recentThreads] = await db.query("SELECT t.id, t.title, u.name as creator_name FROM qa_threads t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC LIMIT 10");
        const [auditLogs] = await db.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 20");

        res.render('base', {
            body: await ejs.renderFile(path.join(__dirname, '../views/admin-dashboard.ejs'), {
                stats: { total_users: userCount[0].c, active_sessions: sessionCount[0].c, pending_tutors: tutorCount[0].c, resources_count: resCount[0].c },
                unapprovedTutors, allUsers, recentResources, recentThreads, auditLogs, user: req.session.user
            })
        });
    } catch (err) { console.error(err); res.status(500).send('Admin Error'); }
});

// Corrected Admin Approval Route (Auto-Assigns Course)
// POST /admin/approve-tutor/:id - Finalized Logic
// POST /admin/approve-tutor/:id - Finalized Create-or-Link Logic
// POST /admin/approve-tutor/:id - Finalized "Create or Link" Logic
router.post('/admin/approve-tutor/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const tutorId = req.params.id;

        // 1. Get Tutor Details and Requested Subject
        const [tutors] = await db.query(
            "SELECT subjects FROM tutors WHERE id = ?", 
            [tutorId]
        );
        
        if (tutors.length === 0) return res.redirect('/admin/dashboard');

        // Safely extract the requested course title from the JSON string
        const subjects = JSON.parse(tutors[0].subjects);
        const requestedSubject = subjects[0];
        
        let courseIdToLink;

        // 2. CHECK if Course EXISTS (Look up by exact title)
        const [courses] = await db.query(
            "SELECT id FROM courses WHERE title = ? LIMIT 1", 
            [requestedSubject]
        );
        
        if (courses.length > 0) {
            // Course Found: Use existing ID
            courseIdToLink = courses[0].id;
        } else {
            // Course NOT Found: CREATE NEW COURSE
            // Create a simple, safe code by taking the first few letters
            const safeCode = requestedSubject.substring(0, Math.min(8, requestedSubject.length)).toUpperCase().replace(/[^A-Z0-9]/g, '');

            const [newCourseResult] = await db.query(
                "INSERT INTO courses (code, title, description) VALUES (?, ?, ?)",
                [safeCode || 'NEW', requestedSubject, 'Course added via tutor registration.']
            );
            courseIdToLink = newCourseResult.insertId;
        }

        // 3. Approve the Tutor (CRITICAL UPDATE)
        await db.query("UPDATE tutors SET is_approved = 1 WHERE id = ?", [tutorId]);

        // 4. Create the Course Link
        if (courseIdToLink) {
            // Insert the link only if it doesn't already exist
            await db.query(
                "INSERT INTO tutor_courses (tutor_id, course_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE tutor_id = tutor_id", 
                [tutorId, courseIdToLink]
            );
        }

        await logAdminAction(req.session.user.id, `Approved Tutor ID ${tutorId}. Linked to course ID ${courseIdToLink || 'N/A'}`);
        res.redirect('/admin/dashboard');

    } catch (err) { 
        console.error("CRASH: Admin Approval Failed:", err); 
        // Send a clear error message to the admin if the DB fails
        res.status(500).send("SERVER CRASH: Approval failed. Check terminal logs for DB error details."); 
    }
});
router.post('/admin/reject-tutor/:userId', isAuthenticated, isAdmin, async (req, res) => {
    await db.query("DELETE FROM users WHERE id = ?", [req.params.userId]);
    await logAdminAction(req.session.user.id, `Rejected User ID ${req.params.userId}`);
    res.redirect('/admin/dashboard');
});
router.post('/admin/suspend-user/:id', isAuthenticated, isAdmin, async (req, res) => {
    await db.query("UPDATE users SET status = 'suspended' WHERE id = ?", [req.params.id]);
    await logAdminAction(req.session.user.id, `Suspended User ID ${req.params.id}`);
    res.redirect('/admin/dashboard');
});
router.post('/admin/activate-user/:id', isAuthenticated, isAdmin, async (req, res) => {
    await db.query("UPDATE users SET status = 'active' WHERE id = ?", [req.params.id]);
    await logAdminAction(req.session.user.id, `Activated User ID ${req.params.id}`);
    res.redirect('/admin/dashboard');
});
router.post('/admin/delete-resource/:id', isAuthenticated, isAdmin, async (req, res) => {
    await db.query("DELETE FROM resources WHERE id = ?", [req.params.id]);
    await logAdminAction(req.session.user.id, `Deleted Resource ID ${req.params.id}`);
    res.redirect('/admin/dashboard');
});
router.post('/admin/delete-thread/:id', isAuthenticated, isAdmin, async (req, res) => {
    await db.query("DELETE FROM qa_threads WHERE id = ?", [req.params.id]);
    await logAdminAction(req.session.user.id, `Deleted Thread ID ${req.params.id}`);
    res.redirect('/admin/dashboard');
});

// --- Q&A ---
router.get('/qa', isAuthenticated, async (req, res) => {
    try {
        const { search, course_id } = req.query;
        const [courses] = await db.query("SELECT * FROM courses ORDER BY title");
        let query = `SELECT t.*, u.name AS creator_name, c.title AS course_title, (SELECT COUNT(*) FROM qa_posts WHERE thread_id = t.id) AS reply_count FROM qa_threads t JOIN users u ON t.user_id = u.id LEFT JOIN courses c ON t.course_id = c.id WHERE 1=1`;
        const params = [];
        if (search) { query += ' AND (t.title LIKE ? OR t.content LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
        if (course_id) { query += ' AND t.course_id = ?'; params.push(course_id); }
        query += ' ORDER BY t.created_at DESC';
        const [threads] = await db.query(query, params);
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'qa-threads.ejs'), { qaThreads: threads, courses, search: search||'', course_id: course_id||'', user: req.session.user }) });
    } catch (err) { res.status(500).send('Error'); }
});

router.get('/qa/create', isAuthenticated, async (req, res) => {
    try {
        const [courses] = await db.query("SELECT * FROM courses ORDER BY title");
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'create-qa-thread.ejs'), { courses, user: req.session.user }) });
    } catch (err) { res.status(500).send('Error'); }
});

router.post('/qa/threads', isAuthenticated, async (req, res) => {
    try {
        await db.query("INSERT INTO qa_threads (user_id, course_id, title, content) VALUES (?, ?, ?, ?)", [req.session.user.id, req.body.course_id || null, req.body.title, req.body.content]);
        res.redirect('/qa');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/qa/threads/:id', isAuthenticated, async (req, res) => {
    try {
        const [threads] = await db.query(`SELECT t.*, u.name AS creator_name, c.title AS course_title FROM qa_threads t JOIN users u ON t.user_id = u.id LEFT JOIN courses c ON t.course_id = c.id WHERE t.id = ?`, [req.params.id]);
        if (threads.length === 0) return res.status(404).send('Not Found');
        const [posts] = await db.query(`SELECT p.*, u.name AS poster_name, u.role AS poster_role FROM qa_posts p JOIN users u ON p.user_id = u.id WHERE p.thread_id = ? ORDER BY p.created_at ASC`, [req.params.id]);
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'qa-thread-detail.ejs'), { thread: threads[0], posts, user: req.session.user }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/qa/threads/:id/reply', isAuthenticated, async (req, res) => {
    try {
        await db.query("INSERT INTO qa_posts (thread_id, user_id, content) VALUES (?, ?, ?)", [req.params.id, req.session.user.id, req.body.content]);
        const [thread] = await db.query("SELECT user_id, title FROM qa_threads WHERE id = ?", [req.params.id]);
        if (thread.length > 0 && thread[0].user_id !== req.session.user.id) {
            await createNotification(thread[0].user_id, 'qa', `New reply: ${thread[0].title}`, `/qa/threads/${req.params.id}`);
        }
        res.redirect(`/qa/threads/${req.params.id}`);
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/report/:type/:id', isAuthenticated, async (req, res) => {
    try {
        const { type, id } = req.params;
        await db.query("INSERT INTO reported_content (reporter_id, content_type, content_id, reason) VALUES (?, ?, ?, 'User reported content')", [req.session.user.id, type, id]);
        res.redirect('back');
    } catch (err) { console.error(err); res.redirect('back'); }
});

// --- MISC ---
router.get('/profile', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [req.session.user.id]);
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'profile.ejs'), { user: rows[0] }) });
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/profile', isAuthenticated, async (req, res) => {
    try {
        await db.query("UPDATE users SET name = ?, avatar = ? WHERE id = ?", [req.body.fullname, req.body.avatar, req.session.user.id]);
        req.session.user.name = req.body.fullname;
        res.redirect('/profile');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/notifications', isAuthenticated, async (req, res) => {
    try {
        const [notifications] = await db.query("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC", [req.session.user.id]);
        const [count] = await db.query("SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0", [req.session.user.id]);
        res.locals.unreadNotificationsCount = count[0].count;
        res.render('base', { body: await ejs.renderFile(path.join(__dirname, '../views', 'notifications.ejs'), { notifications }) });
    } catch (err) { res.status(500).send('Error'); }
});

router.post('/notifications/:id/mark-read', isAuthenticated, async (req, res) => {
    try {
        await db.query("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [req.params.id, req.session.user.id]);
        res.redirect('back');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.post('/notifications/mark-all-read', isAuthenticated, async (req, res) => {
    try {
        await db.query("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.session.user.id]);
        res.redirect('back');
    } catch (err) { console.error(err); res.status(500).send('Error'); }
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => { res.redirect('/'); });
});

module.exports = router;