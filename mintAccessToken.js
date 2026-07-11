require('dotenv').config();

const { sellerA, sellerB } = require('./config/ebayAuth');

async function main() {
  const target = (process.argv[2] || 'sellerA').toLowerCase();
  const manager = target === 'sellerb' || target === 'b' ? sellerB : sellerA;

  const token = await manager.getToken();
  const expiresInMs = Math.max(0, manager.expiresAt - Date.now());
  const expiresInMinutes = Math.ceil(expiresInMs / 60000);

  console.log(JSON.stringify({
    seller: manager.label,
    accessToken: token,
    expiresInMinutes,
    env: process.env.EBAY_ENV || 'production'
  }, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
