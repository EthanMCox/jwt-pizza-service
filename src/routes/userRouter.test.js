const request = require('supertest');
const app = require('../service');
const { authHeader, createAdminUser, expectValidJwt, loginUser, randomEmail, randomName, registerRandomDiner } = require('./testHelpers.js');

test('GET /api/user/me returns 401 without token', async () => {
  const response = await request(app).get('/api/user/me');

  expect(response.status).toBe(401);
  expect(response.body).toMatchObject({ message: 'unauthorized' });
});

test('GET /api/user/me returns authenticated user with valid token', async () => {
  const diner = await registerRandomDiner();

  const response = await request(app).get('/api/user/me').set(authHeader(diner.token));

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject(diner.user);
  expect(response.body).not.toHaveProperty('password');
});

test('PUT /api/user/:userId allows a diner to update their own account', async () => {
  const diner = await registerRandomDiner();
  const update = {
    name: randomName('updated-diner'),
    email: randomEmail('updated-diner'),
    password: 'updated-password',
  };

  const response = await request(app).put(`/api/user/${diner.user.id}`).set(authHeader(diner.token)).send(update);

  expect(response.status).toBe(200);
  expect(response.body.user).toMatchObject({
    id: diner.user.id,
    name: update.name,
    email: update.email,
    roles: [{ role: 'diner' }],
  });
  expect(response.body.user).not.toHaveProperty('password');
  expectValidJwt(response.body.token);
});

test('PUT /api/user/:userId returns 403 when a non-admin updates another user', async () => {
  const diner = await registerRandomDiner();
  const otherDiner = await registerRandomDiner();

  const response = await request(app)
    .put(`/api/user/${otherDiner.user.id}`)
    .set(authHeader(diner.token))
    .send({ name: randomName('forbidden-update') });

  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ message: 'unauthorized' });
});

test('PUT /api/user/:userId allows an admin to update another user', async () => {
  const admin = await createAdminUser();
  const adminLogin = await loginUser(admin.email, admin.password);
  const diner = await registerRandomDiner();
  const update = {
    name: randomName('admin-updated-diner'),
    email: randomEmail('admin-updated-diner'),
    password: 'admin-updated-password',
  };

  const response = await request(app).put(`/api/user/${diner.user.id}`).set(authHeader(adminLogin.body.token)).send(update);

  expect(response.status).toBe(200);
  expect(response.body.user).toMatchObject({
    id: diner.user.id,
    name: update.name,
    email: update.email,
    roles: [{ role: 'diner' }],
  });
  expectValidJwt(response.body.token);
});
