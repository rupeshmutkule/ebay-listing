# Running the eBay Listing Server

## Prerequisites
- Node.js installed
- Dependencies installed: `npm install`

## Running the Server

### Option 1: Development Mode with Nodemon (Auto-restart on changes)
```bash
npm run dev
```

### Option 2: Production Mode
```bash
npm start
```

### Option 3: Direct Node Command
```bash
node app.js
```

## Server Details
- **Port:** 3002 (configurable via PORT environment variable)
- **Main URL:** http://localhost:3002/ebay-store-migration
- **API Endpoints:** 
  - `/ebay-store-migration` - Migration tool interface
  - `/ebay-listings` - Listing management APIs

## Environment Variables
Make sure your `.env` file contains:
- `PORT=3002`
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RUNAME`
- `SELLER_B_REFRESH_TOKEN`
- `EBAY_CATEGORY_ID`
- Other required eBay API credentials

## Troubleshooting

### Server exits immediately
If you're using `dotenvx` CLI wrapper and the server exits after starting:
1. The server is actually starting but dotenvx is causing early exit
2. Use the batch file or run node directly: `C:\nvm4w\nodejs\node.exe app.js`
3. Or temporarily disable dotenvx

### Dependencies
Install missing packages:
```bash
npm install xlsx nodemon
```

## Key Changes
- Added `nodemon` for development with auto-restart
- Fixed token handling for eBay Inventory API
- Token mode set to 'auto' with fallback for compatibility
- Server configured to use Seller B by default (set `LISTING_SELLER=B` in .env)

## Seller B OAuth connection

The listing page includes a **Connect Semi Equipment eBay** button. Set `PUBLIC_BASE_URL` to the public HTTPS origin of this app. Configure the Production eBay RuName accept URL to exactly `PUBLIC_BASE_URL/ebay-listings/oauth/callback`, and set `EBAY_RUNAME` to the RuName identifier. The app stores temporary OAuth state and an AES-256-GCM-encrypted Seller B refresh token in MongoDB, so it works across Vercel function instances without writing credentials to the deployment filesystem.

Required server environment variables:
- `MONGO_URI` — MongoDB Atlas connection URI for the `ebay` database. Add as a Vercel Secret; never commit it.
- `EBAY_TOKEN_ENCRYPTION_KEY` — 64 hexadecimal characters (32 random bytes), stored as a Vercel Secret. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep the same key for as long as encrypted tokens must remain readable; rotating it requires decrypting/re-encrypting existing records first.
- `PUBLIC_BASE_URL=https://ebay-list.vercel.app`
- `EBAY_RUNAME` — the exact RuName identifier from eBay Developer Portal, not the callback URL.
- `EBAY_OAUTH_SCOPES` — space-separated eBay scopes granted at authorization, including `sell.inventory` and `sell.account`.

MongoDB collections are created automatically: `ebay_oauth_states` (short-lived state documents with a TTL index) and `ebay_oauth_credentials` (encrypted Seller B refresh token). Configure Atlas Network Access and a database user for the app. Do not ask the seller to authorize until both required MongoDB secrets are set and the deployed **Connect Semi Equipment eBay** flow can start successfully. Never log token values, authorization codes, client secrets, or MongoDB URIs. A localhost URL is not reachable by a remote client; use the deployed HTTPS host and configure the matching RuName before asking the seller to connect.
