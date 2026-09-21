const request = require('supertest');
const app = require('../service');
const { DB } = require('../database/database.js');
const {
  authHeader,
  cleanupTestData,
  createAuthenticatedAdmin,
  createTestFranchise,
  createTestStore,
  loginUser,
  randomName,
  registerRandomDiner,
  trackTestFranchise,
} = require('./testHelpers.js');

let adminToken;

beforeAll(async () => {
  const admin = await createAuthenticatedAdmin();
  expect(admin.response.status).toBe(200);
  adminToken = admin.token;
});

afterAll(cleanupTestData);

test('GET /api/franchise returns franchises and more flag without auth', async () => {
  const response = await request(app).get('/api/franchise');

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    franchises: expect.any(Array),
    more: expect.any(Boolean),
  });
});

test('GET /api/franchise/:userId returns 401 without auth token', async () => {
  const diner = await registerRandomDiner();

  const response = await request(app).get(`/api/franchise/${diner.user.id}`);

  expect(response.status).toBe(401);
  expect(response.body).toMatchObject({ message: 'unauthorized' });
});

test('GET /api/franchise/:userId returns own franchises for authenticated user', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);

  const response = await request(app).get(`/api/franchise/${franchiseAdmin.user.id}`).set(authHeader(franchiseAdmin.token));

  expect(response.status).toBe(200);
  expect(response.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: franchise.id,
        name: franchise.name,
      }),
    ])
  );
});

test('GET /api/franchise/:userId allows admin to read another user franchises', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);

  const response = await request(app).get(`/api/franchise/${franchiseAdmin.user.id}`).set(authHeader(adminToken));

  expect(response.status).toBe(200);
  expect(response.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: franchise.id, name: franchise.name })]));
});

test('POST /api/franchise returns 403 for non-admin user', async () => {
  const diner = await registerRandomDiner();

  const response = await request(app)
    .post('/api/franchise')
    .set(authHeader(diner.token))
    .send({ name: randomName('forbidden-franchise'), admins: [{ email: diner.user.email }] });

  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ message: 'unable to create a franchise' });
});

test('POST /api/franchise allows admin to create franchise with admin email list', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchiseRequest = {
    name: randomName('created-franchise'),
    admins: [{ email: franchiseAdmin.user.email }],
  };

  const response = await request(app).post('/api/franchise').set(authHeader(adminToken)).send(franchiseRequest);
  trackTestFranchise(response.body);

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    id: expect.any(Number),
    name: franchiseRequest.name,
    admins: [
      {
        id: franchiseAdmin.user.id,
        name: franchiseAdmin.user.name,
        email: franchiseAdmin.user.email,
      },
    ],
  });
});

test('DELETE /api/franchise/:franchiseId returns 401 without auth token', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);

  const response = await request(app).delete(`/api/franchise/${franchise.id}`);

  expect(response.status).toBe(401);
  expect(response.body).toMatchObject({ message: 'unauthorized' });
});

test('DELETE /api/franchise/:franchiseId deletes franchise and returns success message', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);

  const response = await request(app).delete(`/api/franchise/${franchise.id}`).set(authHeader(adminToken));

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ message: 'franchise deleted' });

  const lookupResponse = await request(app).get('/api/franchise').query({ name: franchise.name });
  expect(lookupResponse.body.franchises).toEqual([]);
});

test('POST /api/franchise/:franchiseId/store returns 403 when user lacks permission', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);
  const diner = await registerRandomDiner();

  const response = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set(authHeader(diner.token))
    .send({ name: randomName('forbidden-store') });

  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ message: 'unable to create a store' });
});

test('POST /api/franchise/:franchiseId/store allows admin or franchise admin to create store', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);
  const franchiseAdminLogin = await loginUser(franchiseAdmin.credentials.email, franchiseAdmin.credentials.password);
  const adminStoreName = randomName('admin-store');
  const franchiseAdminStoreName = randomName('franchise-admin-store');

  const adminResponse = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set(authHeader(adminToken))
    .send({ name: adminStoreName });
  const franchiseAdminResponse = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set(authHeader(franchiseAdminLogin.body.token))
    .send({ name: franchiseAdminStoreName });

  expect(adminResponse.status).toBe(200);
  expect(adminResponse.body).toMatchObject({ franchiseId: franchise.id, name: adminStoreName });
  expect(franchiseAdminResponse.status).toBe(200);
  expect(franchiseAdminResponse.body).toMatchObject({ franchiseId: franchise.id, name: franchiseAdminStoreName });
});

test('DELETE /api/franchise/:franchiseId/store/:storeId returns 403 when user lacks permission', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);
  const store = await createTestStore(franchise.id, { name: randomName('protected-store') });
  const diner = await registerRandomDiner();

  const response = await request(app)
    .delete(`/api/franchise/${franchise.id}/store/${store.id}`)
    .set(authHeader(diner.token));

  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ message: 'unable to delete a store' });
});

test('DELETE /api/franchise/:franchiseId/store/:storeId allows authorized deletion', async () => {
  const franchiseAdmin = await registerRandomDiner();
  const franchise = await createFranchiseFor(franchiseAdmin);
  const store = await createTestStore(franchise.id, { name: randomName('deletable-store') });
  const franchiseAdminLogin = await loginUser(franchiseAdmin.credentials.email, franchiseAdmin.credentials.password);

  const response = await request(app)
    .delete(`/api/franchise/${franchise.id}/store/${store.id}`)
    .set(authHeader(franchiseAdminLogin.body.token));

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ message: 'store deleted' });

  const storedFranchise = await DB.getFranchise({ id: franchise.id });
  expect(storedFranchise.stores).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: store.id })]));
});

async function createFranchiseFor(franchiseAdmin) {
  return createTestFranchise({
    name: randomName('franchise'),
    admins: [{ email: franchiseAdmin.credentials.email }],
  });
}
