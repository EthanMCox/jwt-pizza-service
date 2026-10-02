const request = require('supertest');
const app = require('../service');
const { authHeader, cleanupTestData, createAuthenticatedAdmin, expectValidJwt, randomEmail, randomName, registerRandomDiner } = require('./testHelpers.js');

afterAll(cleanupTestData);

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
  const admin = await createAuthenticatedAdmin();
  expect(admin.response.status).toBe(200);
  expectValidJwt(admin.token);
  const diner = await registerRandomDiner();
  const update = {
    name: randomName('admin-updated-diner'),
    email: randomEmail('admin-updated-diner'),
    password: 'admin-updated-password',
  };

  const response = await request(app).put(`/api/user/${diner.user.id}`).set(authHeader(admin.token)).send(update);

  expect(response.status).toBe(200);
  expect(response.body.user).toMatchObject({
    id: diner.user.id,
    name: update.name,
    email: update.email,
    roles: [{ role: 'diner' }],
  });
  expectValidJwt(response.body.token);
});

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');
  expect(listUsersRes.status).toBe(401);
});

test('list users', async () => {
  const [user, userToken] = await registerUser(request(app));
  const listUsersRes = await request(app)
    .get('/api/user')
    .set('Authorization', 'Bearer ' + userToken);
  expect(listUsersRes.status).toBe(200);
});

async function registerUser(service) {
  const testUser = {
    name: 'pizza diner',
    email: `${randomName()}@test.com`,
    password: 'a',
  };
  const registerRes = await service.post('/api/auth').send(testUser);
  registerRes.body.user.password = testUser.password;

  return [registerRes.body.user, registerRes.body.token];
}

async function registerDinersWithSharedName(count) {
  const sharedName = randomName('list-users');
  const diners = [];
  for (let i = 0; i < count; i++) {
    diners.push(await registerRandomDiner({ name: `${sharedName}-${i}` }));
  }
  return { sharedName, diners };
}

test('GET /api/user returns a list of users without passwords', async () => {
  const admin = await createAuthenticatedAdmin();
  const diner = await registerRandomDiner();

  const response = await request(app).get(`/api/user?name=${diner.user.name}`).set(authHeader(admin.token));

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    users: [
      {
        id: diner.user.id,
        name: diner.user.name,
        email: diner.user.email,
        roles: [{ role: 'diner' }],
      },
    ],
    more: false,
  });
  expect(response.body.users[0]).not.toHaveProperty('password');
});

test('GET /api/user returns at most 10 users by default', async () => {
  const admin = await createAuthenticatedAdmin();
  const { sharedName } = await registerDinersWithSharedName(11);

  const response = await request(app).get(`/api/user?name=${sharedName}*`).set(authHeader(admin.token));

  expect(response.status).toBe(200);
  expect(response.body.users).toHaveLength(10);
  expect(response.body.more).toBe(true);
});

test('GET /api/user paginates results using page and limit', async () => {
  const admin = await createAuthenticatedAdmin();
  const { sharedName, diners } = await registerDinersWithSharedName(3);

  const firstPage = await request(app).get(`/api/user?page=0&limit=2&name=${sharedName}*`).set(authHeader(admin.token));
  const secondPage = await request(app).get(`/api/user?page=1&limit=2&name=${sharedName}*`).set(authHeader(admin.token));

  expect(firstPage.status).toBe(200);
  expect(firstPage.body.users).toHaveLength(2);
  expect(firstPage.body.more).toBe(true);

  expect(secondPage.status).toBe(200);
  expect(secondPage.body.users).toHaveLength(1);
  expect(secondPage.body.more).toBe(false);

  const returnedIds = [...firstPage.body.users, ...secondPage.body.users].map((user) => user.id).sort();
  const expectedIds = diners.map((diner) => diner.user.id).sort();
  expect(returnedIds).toEqual(expectedIds);
});

test('GET /api/user returns an empty list for a page past the end', async () => {
  const admin = await createAuthenticatedAdmin();
  const { sharedName } = await registerDinersWithSharedName(2);

  const response = await request(app).get(`/api/user?page=2&limit=2&name=${sharedName}*`).set(authHeader(admin.token));

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ users: [], more: false });
});

test('GET /api/user filters users by exact name', async () => {
  const admin = await createAuthenticatedAdmin();
  const target = await registerRandomDiner({ name: randomName('exact') });
  await registerRandomDiner({ name: `${target.user.name}-extra` });

  const response = await request(app).get(`/api/user?name=${target.user.name}`).set(authHeader(admin.token));

  expect(response.status).toBe(200);
  expect(response.body.users).toHaveLength(1);
  expect(response.body.users[0]).toMatchObject({ id: target.user.id, name: target.user.name });
});

test('GET /api/user filters users by name with a wildcard', async () => {
  const admin = await createAuthenticatedAdmin();
  const { sharedName, diners } = await registerDinersWithSharedName(3);
  const unrelatedDiner = await registerRandomDiner();

  const response = await request(app).get(`/api/user?name=${sharedName}*`).set(authHeader(admin.token));

  expect(response.status).toBe(200);
  const returnedIds = response.body.users.map((user) => user.id).sort();
  expect(returnedIds).toEqual(diners.map((diner) => diner.user.id).sort());
  expect(returnedIds).not.toContain(unrelatedDiner.user.id);
});

test('GET /api/user filters users by name containing a substring', async () => {
  const admin = await createAuthenticatedAdmin();
  const target = await registerRandomDiner({ name: `prefix-${randomName('contains')}-suffix` });
  const middle = target.user.name.slice('prefix-'.length, -'-suffix'.length);

  const response = await request(app).get(`/api/user?name=*${middle}*`).set(authHeader(admin.token));

  expect(response.status).toBe(200);
  expect(response.body.users).toHaveLength(1);
  expect(response.body.users[0]).toMatchObject({ id: target.user.id, name: target.user.name });
});

test('GET /api/user returns an empty list when no names match', async () => {
  const admin = await createAuthenticatedAdmin();

  const response = await request(app).get(`/api/user?name=${randomName('no-such-user')}`).set(authHeader(admin.token));

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ users: [], more: false });
});
