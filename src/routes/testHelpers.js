const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

const createdUserIds = new Set();
const createdMenuItemIds = new Set();
const createdFranchiseIds = new Set();
const createdStoreIds = new Set();

function randomName(prefix = 'user') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function randomEmail(prefix = 'user', domain = 'test.com') {
  return `${randomName(prefix)}@${domain}`;
}

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerRandomDiner(overrides = {}) {
  const credentials = {
    name: randomName('diner'),
    email: randomEmail('diner'),
    password: 'a',
    ...overrides,
  };

  const response = await request(app).post('/api/auth').send(credentials);
  trackId(createdUserIds, response.body.user);
  return {
    credentials,
    response,
    user: response.body.user,
    token: response.body.token,
  };
}

async function loginUser(email, password) {
  return request(app).put('/api/auth').send({ email, password });
}

async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName('admin');
  user.email = `${user.name}@admin.com`;

  user = await DB.addUser(user);
  trackId(createdUserIds, user);
  return { ...user, password: 'toomanysecrets' };
}

async function createAuthenticatedAdmin() {
  const user = await createAdminUser();
  const response = await loginUser(user.email, user.password);
  return { user, response, token: response.body.token };
}

async function createTestMenuItem(item) {
  const menuItem = await DB.addMenuItem(item);
  trackId(createdMenuItemIds, menuItem);
  return menuItem;
}

async function createTestFranchise(franchise) {
  const createdFranchise = await DB.createFranchise(franchise);
  trackId(createdFranchiseIds, createdFranchise);
  return createdFranchise;
}

async function createTestStore(franchiseId, store) {
  const createdStore = await DB.createStore(franchiseId, store);
  trackId(createdStoreIds, createdStore);
  return createdStore;
}

function trackTestMenuItem(menuItem) {
  trackId(createdMenuItemIds, menuItem);
}

function trackTestFranchise(franchise) {
  trackId(createdFranchiseIds, franchise);
}

async function cleanupTestData() {
  const connection = await DB.getConnection();
  try {
    await connection.beginTransaction();

    const userIds = [...createdUserIds];
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => '?').join(',');
      await DB.query(
        connection,
        `DELETE oi FROM orderItem AS oi JOIN dinerOrder AS orders ON orders.id=oi.orderId WHERE orders.dinerId IN (${placeholders})`,
        userIds
      );
      await deleteByIds(connection, 'dinerOrder', 'dinerId', userIds);
    }

    await deleteByIds(connection, 'store', 'id', [...createdStoreIds]);

    const franchiseIds = [...createdFranchiseIds];
    if (franchiseIds.length > 0) {
      await deleteByIds(connection, 'store', 'franchiseId', franchiseIds);
      await deleteByIds(connection, 'userRole', 'objectId', franchiseIds);
      await deleteByIds(connection, 'franchise', 'id', franchiseIds);
    }

    await deleteByIds(connection, 'menu', 'id', [...createdMenuItemIds]);

    if (userIds.length > 0) {
      await deleteByIds(connection, 'auth', 'userId', userIds);
      await deleteByIds(connection, 'userRole', 'userId', userIds);
      await deleteByIds(connection, 'user', 'id', userIds);
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.end();
    createdUserIds.clear();
    createdMenuItemIds.clear();
    createdFranchiseIds.clear();
    createdStoreIds.clear();
  }
}

function trackId(collection, value) {
  const id = typeof value === 'object' ? value?.id : value;
  if (Number.isInteger(id)) {
    collection.add(id);
  }
}

async function deleteByIds(connection, table, column, ids) {
  if (ids.length === 0) {
    return;
  }

  const placeholders = ids.map(() => '?').join(',');
  await DB.query(connection, `DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, ids);
}

module.exports = {
  authHeader,
  cleanupTestData,
  createAuthenticatedAdmin,
  createTestFranchise,
  createTestMenuItem,
  createTestStore,
  expectValidJwt,
  loginUser,
  randomEmail,
  randomName,
  registerRandomDiner,
  trackTestFranchise,
  trackTestMenuItem,
};
