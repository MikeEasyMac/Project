const request = require('supertest');
const app = require('../server'); // Adjust the path to your server.js file

describe('Authentication Routes', () => {
  it('should show the login page', async () => {
    const res = await request(app).get('/login');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toContain('<h2>Login</h2>');
  });

  it('should show the signup page', async () => {
    const res = await request(app).get('/signup');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toContain('<h2>Create Account</h2>');
  });
});
