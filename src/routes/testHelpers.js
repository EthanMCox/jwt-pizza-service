const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

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
  return { ...user, password: 'toomanysecrets' };
}

module.exports = {
  authHeader,
  createAdminUser,
  expectValidJwt,
  loginUser,
  randomEmail,
  randomName,
  registerRandomDiner,
};
