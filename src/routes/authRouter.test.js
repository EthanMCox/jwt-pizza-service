const request = require('supertest');
const app = require('../service');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

describe('authRouter', () => {
  test('register returns 400 when required fields are missing', async () => {
    const response = await request(app).post('/api/auth').send({ email: randomEmail('missing-fields') });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ message: 'name, email, and password are required' });
  });

  test('rejects protected route without token', async () => {
    const response = await request(app).get('/api/user/me');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ message: 'unauthorized' });
  });

  test('logout succeeds with valid token', async () => {
    const user = { name: 'logout-user', email: randomEmail('logout'), password: 'a' };
    const registerRes = await request(app).post('/api/auth').send(user);
    const token = registerRes.body.token;

    const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body).toMatchObject({ message: 'logout successful' });
  });

  test('logged out token can no longer access protected route', async () => {
    const user = { name: 'logout-lockout-user', email: randomEmail('logout-lockout'), password: 'a' };
    const registerRes = await request(app).post('/api/auth').send(user);
    const token = registerRes.body.token;

    await request(app).delete('/api/auth').set('Authorization', `Bearer ${token}`);

    const protectedRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
    expect(protectedRes.status).toBe(401);
    expect(protectedRes.body).toMatchObject({ message: 'unauthorized' });
  });

  test('malformed token does not authorize protected route', async () => {
    const response = await request(app).get('/api/user/me').set('Authorization', 'Bearer not.a.real.jwt');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ message: 'unauthorized' });
  });
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

function randomEmail(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
}
