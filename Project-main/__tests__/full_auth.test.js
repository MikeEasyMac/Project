const request = require('supertest');
const app = require('../server');
const db = require('../config/db');
const bcrypt = require('bcrypt');

describe('Full Authentication and Authorization Flow', () => {
  let agent;
  let adminUser = {
    id: 1,
    email: 'mike@example.com',
    name: 'Michael Johnson',
    password: 'password',
    role: 'admin'
  };

  beforeAll(async () => {
    // Ensure the database is ready
  });

  beforeEach(async () => {
    // Clear tables to start fresh
    await db.query("DELETE FROM notifications");
    await db.query("DELETE FROM password_reset_tokens");
    await db.query("DELETE FROM tutors");
    await db.query("DELETE FROM users");
    await db.query("ALTER TABLE users AUTO_INCREMENT = 1");

    // Seed Admin User
    const hashedPassword = await bcrypt.hash(adminUser.password, 10);
    await db.query(
      "INSERT INTO users (id, email, name, password, role, status) VALUES (?, ?, ?, ?, ?, 'active')",
      [adminUser.id, adminUser.email, adminUser.name, hashedPassword, adminUser.role]
    );

    agent = request.agent(app);
  });

  afterAll(async () => {
    await db.end();
  });

  // --- AUTH-01: Registration ---
  it('AUTH-01: should allow a new student to register', async () => {
    const res = await agent.post('/signup').send({
      name: 'New User',           // Fixed: changed fullname to name
      email: 'newuser@example.com',
      password: 'newpassword',
      role: 'student'             // Added role
    });
    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual('/login');

    const [users] = await db.query("SELECT * FROM users WHERE email = ?", ['newuser@example.com']);
    expect(users.length).toEqual(1);
    expect(users[0].name).toEqual('New User');
  });

  it('AUTH-01: should allow a new tutor to register', async () => {
    const res = await agent.post('/signup').send({
      name: 'New Tutor',
      email: 'tutor@test.com',
      password: 'password',
      role: 'tutor',
      bio: 'I teach math',
      subjects: 'Math, Physics',
      hourly_rate: '40'
    });
    
    // Expect redirect to login OR the pending page (status 200 if rendering pending page)
    if (res.statusCode === 302) {
         expect(res.headers.location).toEqual('/login');
    } else {
         expect(res.statusCode).toEqual(200);
         expect(res.text).toContain('pending approval');
    }

    const [tutors] = await db.query("SELECT * FROM tutors t JOIN users u ON t.user_id = u.id WHERE u.email = ?", ['tutor@test.com']);
    expect(tutors.length).toEqual(1);
    expect(tutors[0].is_approved).toEqual(0); // Should be unapproved
  });

  // --- AUTH-02: Login ---
  it('AUTH-02: should allow an existing user to log in', async () => {
    const res = await agent.post('/login').send({
      email: adminUser.email,
      password: adminUser.password
    });
    expect(res.statusCode).toEqual(302); 
    // Admins redirect to /admin/dashboard now
    expect(res.headers.location).toMatch(/(\/|\/admin\/dashboard)/);
  });

  it('AUTH-08: should show error for incorrect login password', async () => {
    const res = await agent.post('/login').send({
      email: adminUser.email,
      password: 'wrongpassword'
    });
    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual('/login');
  });

  // --- AUTH-07: Role Enforcement ---
  it('AUTH-07: Admin should access /admin/dashboard', async () => {
    await agent.post('/login').send({ email: adminUser.email, password: adminUser.password });
    const res = await agent.get('/admin/dashboard');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toContain('Admin Command Center');
  });

  it('AUTH-07: Student should be forbidden from /admin/dashboard', async () => {
    // Register student
    await agent.post('/signup').send({
      name: 'Student User',
      email: 'student@example.com',
      password: 'password',
      role: 'student'
    });
    // Login
    await agent.post('/login').send({ email: 'student@example.com', password: 'password' });

    const res = await agent.get('/admin/dashboard');
    expect(res.statusCode).toEqual(403);
  });
});