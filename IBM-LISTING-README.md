# IBM eBay draft listing

This adds a simple Express page with Excel/CSV upload, row validation, progress logs, and one Seller B live-product view. It creates **unpublished eBay offers** only; it does not publish offers or add images. An offer becomes a live listing only through a separate `publishOffer` call, and this project does not add that call.

The existing `createProduct.js` is a separate Sandbox demo that calls `publishOffer`; do not use it for the production draft batch.

## Before starting the server

Add these values to the existing `.env` without replacing its current migration credentials:

```env
IBM_LISTING_XLSX=C:\Users\rupes\Downloads\IBM eBay List - 10-5-2026.xlsx
IBM_EBAY_CATEGORY_ID=40004
IBM_MERCHANT_LOCATION_KEY=IBM_PHOENIX_85004
IBM_RETURN_POLICY_ID=REST_ACCOUNT_API_RETURN_POLICY_ID
IBM_MAX_SHIPPING_DELTA=25
```

This workflow is fixed to Seller B (Semi Equipment), using `sellerB` from the existing `config/ebayAuth.js`. Seller B's token needs `sell.inventory` and `sell.account` scopes. Do not put access tokens in these new settings.

For the **View products on Semi Equipment Store (Seller B)** button, the app can use a Seller B Auth'n'Auth token with the legacy Trading API. Add it locally to `.env` as `SELLER_B_AUTH_TOKEN=...`; never paste the token into chat or commit it. The Inventory REST API used for unpublished draft offers still requires a valid Seller B OAuth user token with `sell.inventory` and `sell.account` scopes. An Auth'n'Auth token cannot replace that OAuth authorization for draft creation.

If eBay has a single payment policy named “eBay Managed Payments”, the service selects it automatically. Otherwise set `IBM_PAYMENT_POLICY_ID` to the matching REST Account API policy ID. The spreadsheet guideline's numeric legacy Trading API profile ID (`261857207024`) is not the same kind of ID. `IBM_RETURN_POLICY_ID` must be the return policy the client wants on these drafts; the project does not guess it.

The service selects a domestic, flat-rate fulfillment policy with a single shipping service, 5-day handling, and the exact spreadsheet price when available. If exact cost is absent, it allows a closest policy within `$25` (set `IBM_MAX_SHIPPING_DELTA` to adjust). It skips rows when no matching policy exists. Rows marked `Freight`/`Freight!` are skipped for manual freight-policy setup.

The workflow creates/checks the inventory location key at ZIP `85004`, uses category `40004`, quantity `1`, condition `USED`, and an item description containing Asset #, Make, Model, Type, and Configuration. Best Offer is enabled for asking prices over `$2,000`. No photos are uploaded.

Ensure at least one of `MIGRATION_TOOL_API_KEY`, `API_KEY`, or `SHARED_SECRET` is configured before using these routes. Listing endpoints return `503` if no key is set.

## Endpoints

Start the existing Express app with `node app.js`, then use the same `X-Api-Key` header as the migration routes:

- `GET /ebay-listings/preview` — reads the workbook and eBay fulfillment policies; makes no listing changes.
- `GET /ebay-listings/readiness` — checks required environment values and reads Seller B account policies; makes no listing changes.
- `POST /ebay-listings/preview-csv` — validates an uploaded CSV; makes no listing changes.
- `POST /ebay-listings/drafts-csv` — starts a sequential batch from the uploaded CSV and creates unpublished offers only.
- `POST /ebay-listings/drafts` — starts a sequential batch that creates inventory items and unpublished offers only.
- `GET /ebay-listings/drafts/:jobId` — reads job progress/results, including skipped rows and API errors.

The page's **View products on Semi Equipment Store (Seller B)** button calls the existing Seller B endpoint and displays live listings with their eBay links. Drafts remain in the CSV job log until they are published separately.

The batch records its latest state in `data/ibm-draft-listing-state.json`. Review the preview and set up any missing shipping policies before posting drafts. No route in this feature publishes or activates an offer.
