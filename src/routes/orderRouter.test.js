const request = require('supertest');
const app = require('../service');
const {
  authHeader,
  cleanupTestData,
  createAuthenticatedAdmin,
  createTestFranchise,
  createTestMenuItem,
  createTestStore,
  expectValidJwt,
  randomName,
  registerRandomDiner,
  trackTestMenuItem,
} = require('./testHelpers.js');

let diner;
let menuItem;
let orderLocation;

beforeAll(async () => {
  diner = await registerRandomDiner();
  expect(diner.response.status).toBe(200);
  expectValidJwt(diner.token);

  menuItem = await createTestMenuItem({
    title: randomName('order-menu-item'),
    description: 'Menu item used by order route tests',
    image: 'order-test.png',
    price: 0.01,
  });

  const franchise = await createTestFranchise({
    name: randomName('order-franchise'),
    admins: [{ email: diner.credentials.email }],
  });
  const store = await createTestStore(franchise.id, { name: randomName('order-store') });
  orderLocation = { franchiseId: franchise.id, storeId: store.id };
});

afterAll(cleanupTestData);

afterEach(() => {
  jest.restoreAllMocks();
});

test('GET /api/order/menu returns menu without auth', async () => {
  const response = await request(app).get('/api/order/menu');

  expect(response.status).toBe(200);
  expect(response.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: menuItem.id,
        title: menuItem.title,
        description: menuItem.description,
        image: menuItem.image,
        price: menuItem.price,
      }),
    ])
  );
});

test('PUT /api/order/menu returns 401 without auth token', async () => {
  const response = await request(app).put('/api/order/menu').send(newMenuItem());

  expect(response.status).toBe(401);
  expect(response.body).toMatchObject({ message: 'unauthorized' });
});

test('PUT /api/order/menu returns 403 for non-admin user', async () => {
  const response = await request(app).put('/api/order/menu').set(authHeader(diner.token)).send(newMenuItem());

  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ message: 'unable to add menu item' });
});

test('PUT /api/order/menu allows admin to add menu item and returns updated menu', async () => {
  const admin = await createAuthenticatedAdmin();
  expect(admin.response.status).toBe(200);
  expectValidJwt(admin.token);
  const item = newMenuItem();
  const response = await request(app).put('/api/order/menu').set(authHeader(admin.token)).send(item);
  const createdItem = response.body.find((menuEntry) => menuEntry.title === item.title);
  trackTestMenuItem(createdItem);

  expect(response.status).toBe(200);
  expect(response.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: expect.any(Number),
        ...item,
      }),
    ])
  );
});

test('GET /api/order returns 401 without auth token', async () => {
  const response = await request(app).get('/api/order');

  expect(response.status).toBe(401);
  expect(response.body).toMatchObject({ message: 'unauthorized' });
});

test('GET /api/order returns diner orders when authenticated', async () => {
  const response = await request(app).get('/api/order').set(authHeader(diner.token));

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    dinerId: diner.user.id,
    orders: expect.any(Array),
    page: 1,
  });
});

test('POST /api/order returns order and jwt and sends the correct factory payload', async () => {
  const fetchMock = mockFactoryResponse({ ok: true, jwt: 'factory-jwt' });
  const order = newOrder();

  const response = await request(app).post('/api/order').set(authHeader(diner.token)).send(order);

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    order: { ...order, id: expect.any(Number) },
    jwt: 'factory-jwt',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const requestOptions = fetchMock.mock.calls[0][1];
  expect(JSON.parse(requestOptions.body)).toEqual({
    diner: {
      id: diner.user.id,
      name: diner.user.name,
      email: diner.user.email,
    },
    order: { ...order, id: expect.any(Number) },
  });
});

test('POST /api/order returns 500 with failure message when factory fails', async () => {
  mockFactoryResponse({ ok: false });

  const response = await request(app).post('/api/order').set(authHeader(diner.token)).send(newOrder());

  expect(response.status).toBe(500);
  expect(response.body).toMatchObject({ message: 'Failed to fulfill order at factory' });
});

function newMenuItem() {
  return {
    title: randomName('new-menu-item'),
    description: 'A menu item added during an order route test',
    image: 'new-menu-item.png',
    price: 0.02,
  };
}

function newOrder() {
  return {
    franchiseId: orderLocation.franchiseId,
    storeId: orderLocation.storeId,
    items: [
      {
        menuId: menuItem.id,
        description: menuItem.description,
        price: menuItem.price,
      },
    ],
  };
}

function mockFactoryResponse({ ok, jwt }) {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    json: jest.fn().mockResolvedValue({ jwt }),
  });
}
