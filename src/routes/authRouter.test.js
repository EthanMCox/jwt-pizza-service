const request = require('supertest');
const app = require('../service');
const { authHeader, cleanupTestData, expectValidJwt, randomEmail, registerRandomDiner } = require('./testHelpers.js');

let testUser;

beforeAll(async () => {
  const registration = await registerRandomDiner({ name: 'pizza diner' });
  expect(registration.response.status).toBe(200);
  expectValidJwt(registration.token);
  testUser = registration.credentials;
});

afterAll(cleanupTestData);

test('PUT /api/auth logs in an existing user', async () => {
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

  test('logout invalidates the user token', async () => {
    const user = await registerRandomDiner({ name: 'logout-user' });

    const logoutResponse = await request(app).delete('/api/auth').set(authHeader(user.token));
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.body).toMatchObject({ message: 'logout successful' });

    const protectedRes = await request(app).get('/api/user/me').set(authHeader(user.token));
    expect(protectedRes.status).toBe(401);
    expect(protectedRes.body).toMatchObject({ message: 'unauthorized' });
  });

  test('malformed token does not authorize protected route', async () => {
    const response = await request(app).get('/api/user/me').set('Authorization', 'Bearer not.a.real.jwt');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ message: 'unauthorized' });
  });
});
