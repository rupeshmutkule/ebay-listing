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

The listing page includes a **Connect Semi Equipment eBay** button. Set `PUBLIC_BASE_URL` to the public HTTPS origin of this app. Configure the Production eBay RuName accept URL to exactly `PUBLIC_BASE_URL/ebay-listings/oauth/callback`, and set `EBAY_RUNAME` to that RuName. The app starts OAuth authorization-code consent and exchanges the returned code on the server; it stores only the returned refresh token in the project `.env` as `SELLER_B_REFRESH_TOKEN`. Do not expose token values in logs or browser responses. A localhost URL is not reachable by a remote client; use the deployed HTTPS host or a temporary HTTPS tunnel and configure the matching RuName before asking the seller to connect.
