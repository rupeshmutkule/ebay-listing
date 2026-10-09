const crypto = require('crypto');
const { MongoClient } = require('mongodb');

let clientPromise;
let indexesPromise;

function getClient() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MongoDB is not configured. Set MONGO_URI in the server environment.');
  if (!clientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 });
    clientPromise = client.connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

async function getCollections() {
  const client = await getClient();
  const db = client.db();
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      db.collection('ebay_oauth_states').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('ebay_oauth_credentials').createIndex({ seller: 1 }, { unique: true })
    ]).catch((error) => {
      indexesPromise = null;
      throw error;
    });
  }
  await indexesPromise;
  return {
    states: db.collection('ebay_oauth_states'),
    credentials: db.collection('ebay_oauth_credentials')
  };
}

function encryptionKey() {
  const value = (process.env.EBAY_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('Set EBAY_TOKEN_ENCRYPTION_KEY to a 64-character (32-byte) hex secret.');
  }
  return Buffer.from(value, 'hex');
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decrypt(payload) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function createOAuthState(state, expiresAt) {
  const { states } = await getCollections();
  await states.insertOne({ _id: state, createdAt: new Date(), expiresAt: new Date(expiresAt) });
}

async function consumeOAuthState(state) {
  if (!state) return false;
  const { states } = await getCollections();
  const result = await states.findOneAndDelete({ _id: state, expiresAt: { $gt: new Date() } });
  return Boolean(result && (result.value || result)._id);
}

async function saveSellerBRefreshToken(refreshToken) {
  const { credentials } = await getCollections();
  await credentials.updateOne(
    { seller: 'B' },
    { $set: { seller: 'B', refreshToken: encrypt(refreshToken), updatedAt: new Date() } },
    { upsert: true }
  );
}

async function getSellerBRefreshToken() {
  if (!process.env.MONGO_URI) return (process.env.SELLER_B_REFRESH_TOKEN || '').trim() || null;
  const { credentials } = await getCollections();
  const saved = await credentials.findOne({ seller: 'B' });
  return saved?.refreshToken ? decrypt(saved.refreshToken) : (process.env.SELLER_B_REFRESH_TOKEN || '').trim() || null;
}

async function checkMongoStorage() {
  const client = await getClient();
  await client.db().command({ ping: 1 });
  encryptionKey();
  return true;
}

module.exports = {
  createOAuthState,
  consumeOAuthState,
  saveSellerBRefreshToken,
  getSellerBRefreshToken,
  checkMongoStorage
};
