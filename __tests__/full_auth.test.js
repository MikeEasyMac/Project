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
    // Ensure the database is ready and schema is applied
    // In a real scenario, you might run migrations here
  });

  beforeEach(async () => {
    // Clear users and password_reset_tokens tables
    await db.execute("DELETE FROM password_reset_tokens");
    await db.execute("DELETE FROM users");
    await db.execute("ALTER TABLE users AUTO_INCREMENT = 1");

    // Re-seed the admin user with a hashed password
    const hashedPassword = await bcrypt.hash(adminUser.password, 10);
    await db.execute(
      "INSERT INTO users (id, email, name, password, role) VALUES (?, ?, ?, ?, ?)",
      [adminUser.id, adminUser.email, adminUser.name, hashedPassword, adminUser.role]
    );

    agent = request.agent(app); // Use an agent to persist sessions
  });

  afterAll(async () => {
    await db.end(); // Close the database connection after all tests
  });

  // --- AUTH-01: Registration ---
  it('AUTH-01: should allow a new user to register', async () => {
    const res = await agent.post('/signup').send({
      fullname: 'New User',
      email: 'newuser@example.com',
      password: 'newpassword'
    });
    expect(res.statusCode).toEqual(302); // Redirect to login
    expect(res.headers.location).toEqual('/login');

    const [users] = await db.execute("SELECT * FROM users WHERE email = ?", ['newuser@example.com']);
    expect(users.length).toEqual(1);
    expect(users[0].name).toEqual('New User');
  });

  it('AUTH-08: should show error if registration email already exists', async () => {
    const res = await agent.post('/signup').send({
      fullname: 'Existing User',
      email: adminUser.email, // Use existing email
      password: 'somepassword'
    });
    expect(res.statusCode).toEqual(302); // Redirect back to signup
    expect(res.headers.location).toEqual('/signup');

    const signupPage = await agent.get('/signup');
    expect(signupPage.text).toContain('User with this email already exists.');
  });

  // --- AUTH-02: Login ---
  it('AUTH-02: should allow an existing user to log in', async () => {
    const res = await agent.post('/login').send({
      email: adminUser.email,
      password: adminUser.password
    });
    expect(res.statusCode).toEqual(302); // Redirect to home
    expect(res.headers.location).toEqual('/');

    const homePage = await agent.get('/');
    expect(homePage.text).toContain(`Welcome, ${adminUser.name}`);
  });

  it('AUTH-08: should show error for incorrect login password', async () => {
    const res = await agent.post('/login').send({
      email: adminUser.email,
      password: 'wrongpassword'
    });
    expect(res.statusCode).toEqual(302); // Redirect back to login
    expect(res.headers.location).toEqual('/login');

    const loginPage = await agent.get('/login');
    expect(loginPage.text).toContain('Invalid email or password.');
  });

  it('AUTH-08: should show error for non-existent login email', async () => {
    const res = await agent.post('/login').send({
      email: 'nonexistent@example.com',
      password: 'anypassword'
    });
    expect(res.statusCode).toEqual(302); // Redirect back to login
    expect(res.headers.location).toEqual('/login');

    const loginPage = await agent.get('/login');
    expect(loginPage.text).toContain('Invalid email or password.');
  });

  // --- AUTH-04: Persistent Sessions & AUTH-05: Logout ---
  it('AUTH-04 & AUTH-05: should maintain session after login and destroy on logout', async () => {
    // Login
    await agent.post('/login').send({
      email: adminUser.email,
      password: adminUser.password
    });

    // Access a protected route
    const homePage = await agent.get('/');
    expect(homePage.statusCode).toEqual(200);
    expect(homePage.text).toContain(`Welcome, ${adminUser.name}`);

    // Logout
    const logoutRes = await agent.get('/logout');
    expect(logoutRes.statusCode).toEqual(302); // Redirect to login
    expect(logoutRes.headers.location).toEqual('/login');

    // Attempt to access protected route after logout
    const protectedPageAfterLogout = await agent.get('/');
    expect(protectedPageAfterLogout.statusCode).toEqual(302); // Redirect to login
    expect(protectedPageAfterLogout.headers.location).toEqual('/login');
  });

  // --- AUTH-06: Profile Update ---
  it('AUTH-06: should allow a user to update their profile (name and avatar)', async () => {
    // Login first
    await agent.post('/login').send({
      email: adminUser.email,
      password: adminUser.password
    });

    const newName = 'Updated Admin';
    const newAvatar = 'http://example.com/newavatar.jpg';

    const res = await agent.post('/profile').send({
      fullname: newName,
      avatar: newAvatar
    });
    expect(res.statusCode).toEqual(302); // Redirect to profile page
    expect(res.headers.location).toEqual('/profile');

    const [updatedUser] = await db.execute("SELECT * FROM users WHERE id = ?", [adminUser.id]);
    expect(updatedUser[0].name).toEqual(newName);
    expect(updatedUser[0].avatar).toEqual(newAvatar);

    // Verify session is updated
    const profilePage = await agent.get('/profile');
    expect(profilePage.text).toContain(`value="${newName}"`);
    expect(profilePage.text).toContain(`value="${newAvatar}"`);
  });

  // --- AUTH-07: Role Enforcement ---
  it('AUTH-07: Admin should access /users page', async () => {
    await agent.post('/login').send({ email: adminUser.email, password: adminUser.password });
    const res = await agent.get('/users');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toContain('<h2>Users</h2>');
  });

  it('AUTH-07: Non-admin should be forbidden from /users page', async () => {
    // Register a student user
    await agent.post('/signup').send({
      fullname: 'Student User',
      email: 'student@example.com',
      password: 'studentpassword'
    });
    // Login as student
    await agent.post('/login').send({ email: 'student@example.com', password: 'studentpassword' });

    const res = await agent.get('/users');
    expect(res.statusCode).toEqual(403); // Forbidden
  });

  it('AUTH-07: Tutor should access /tutor page', async () => {
    // Register a tutor user
    await db.execute(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
      ['Tutor User', 'tutor@example.com', await bcrypt.hash('tutorpassword', 10), 'tutor']
    );
    // Login as tutor
    await agent.post('/login').send({ email: 'tutor@example.com', password: 'tutorpassword' });

    const res = await agent.get('/tutor');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toContain('<h2>Tutor</h2>');
  });

  it('AUTH-07: Non-tutor should be forbidden from /tutor page', async () => {
    // Login as admin (who is not a tutor by default)
    await agent.post('/login').send({ email: adminUser.email, password: adminUser.password });

    const res = await agent.get('/tutor');
    expect(res.statusCode).toEqual(403); // Forbidden
  });

  // --- AUTH-03: Password Reset ---
  it('AUTH-03: should allow requesting a password reset link', async () => {
    const res = await agent.post('/forgot-password').send({ email: adminUser.email });
    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual('/forgot-password');

    const forgotPasswordPage = await agent.get('/forgot-password');
    expect(forgotPasswordPage.text).toContain('If an account with that email exists, a password reset link has been sent.');

    const [tokens] = await db.execute("SELECT * FROM password_reset_tokens WHERE user_id = ?", [adminUser.id]);
    expect(tokens.length).toEqual(1);
    expect(tokens[0].token).toBeDefined();
  });

  it('AUTH-03: should not reveal if email exists when requesting reset link', async () => {
    const res = await agent.post('/forgot-password').send({ email: 'nonexistent@example.com' });
    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual('/forgot-password');

    const forgotPasswordPage = await agent.get('/forgot-password');
    expect(forgotPasswordPage.text).toContain('If an account with that email exists, a password reset link has been sent.');

    const [tokens] = await db.execute("SELECT * FROM password_reset_tokens WHERE user_id = ?", [adminUser.id]);
    expect(tokens.length).toEqual(0); // No token should be created for non-existent user
  });

  it('AUTH-03: should allow resetting password with a valid token', async () => {
    // Request reset link to get a token
    await agent.post('/forgot-password').send({ email: adminUser.email });
    const [tokens] = await db.execute("SELECT * FROM password_reset_tokens WHERE user_id = ?", [adminUser.id]);
    const token = tokens[0].token;

    const newPassword = 'newsecurepassword';
    const res = await agent.post(`/reset-password/${token}`).send({
      password: newPassword,
      confirmPassword: newPassword
    });
    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual('/login');

    const loginPage = await agent.get('/login');
    expect(loginPage.text).toContain('Your password has been updated. Please log in.');

    // Try logging in with new password
    const loginRes = await agent.post('/login').send({ email: adminUser.email, password: newPassword });
    expect(loginRes.statusCode).toEqual(302);
    expect(loginRes.headers.location).toEqual('/');
  });

  it('AUTH-03: should not allow resetting password with an invalid token', async () => {
    const res = await agent.post(`/reset-password/invalidtoken`).send({
      password: 'newpassword',
      confirmPassword: 'newpassword'
    });
    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual('/forgot-password');

    const forgotPasswordPage = await agent.get('/forgot-password');
    expect(forgotPasswordPage.text).toContain('Password reset token is invalid or has expired.');
  });

  it('AUTH-03: should not allow resetting password with mismatched passwords', async () => {
    // Request reset link to get a token
    await agent.post('/forgot-password').send({ email: adminUser.email });
    const [tokens] = await db.execute("SELECT * FROM password_reset_tokens WHERE user_id = ?", [adminUser.id]);
    const token = tokens[0].token;

    const res = await agent.post(`/reset-password/${token}`).send({
      password: 'newpassword',
      confirmPassword: 'mismatchedpassword'
    });
    expect(res.statusCode).toEqual(302);
    expect(res.headers.location).toEqual(`/reset-password/${token}`);

    const resetPasswordPage = await agent.get(`/reset-password/${token}`);
    expect(resetPasswordPage.text).toContain('Passwords do not match.');
  });
});
