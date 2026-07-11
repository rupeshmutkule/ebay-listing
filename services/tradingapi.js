const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll';
const SITE_ID = '0'; // 0 = EBAY_US
const COMPATIBILITY_LEVEL = '1193';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

function escapeXml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Generic Trading API caller with exponential backoff on throttling/5xx.
// `oauthToken` is the seller's current OAuth access token (from ebayAuth.js).
async function callTradingApi(callName, xmlBody, oauthToken, attempt = 1) {
  if (!oauthToken) {
    throw new Error(`Missing OAuth token for ${callName}`);
  }

  const headers = {
    'X-EBAY-API-SITEID': SITE_ID,
    'X-EBAY-API-COMPATIBILITY-LEVEL': COMPATIBILITY_LEVEL,
    'X-EBAY-API-CALL-NAME': callName,
    'X-EBAY-API-IAF-TOKEN': oauthToken,
    'Content-Type': 'text/xml'
  };

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  ${xmlBody}
</${callName}Request>`;

  try {
    const res = await axios.post(TRADING_API_URL, envelope, { headers, timeout: 30000 });
    const parsed = parser.parse(res.data);
    const root = parsed[`${callName}Response`];

    if (!root) {
      throw new Error(`Unexpected response shape for ${callName}`);
    }

    if (root.Ack === 'Failure') {
      const errors = Array.isArray(root.Errors) ? root.Errors : [root.Errors];
      const isThrottled = errors.some(e => e && String(e.ErrorCode) === '10001');
      if (isThrottled && attempt <= 5) {
        const backoff = Math.min(2000 * 2 ** attempt, 30000);
        console.warn(`[${callName}] throttled, retrying in ${backoff}ms (attempt ${attempt})`);
        await sleep(backoff);
        return callTradingApi(callName, xmlBody, oauthToken, attempt + 1);
      }
      const msg = errors.map(e => e && e.LongMessage).filter(Boolean).join('; ');
      throw new Error(`${callName} failed: ${msg || JSON.stringify(errors)}`);
    }

    return root; // Ack === 'Success' or 'Warning'
  } catch (err) {
    // Retry on transient network / 5xx errors
    const status = err.response?.status;
    if ((status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') && attempt <= 5) {
      const backoff = Math.min(2000 * 2 ** attempt, 30000);
      console.warn(`[${callName}] transient error (${status || err.code}), retrying in ${backoff}ms`);
      await sleep(backoff);
      return callTradingApi(callName, xmlBody, oauthToken, attempt + 1);
    }
    throw err;
  }
}

// ---------- GetItem: pull the full listing from Seller A by Item Number ----------
async function getItem(itemId, oauthToken) {
  const body = `
  <ItemID>${escapeXml(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>`;
  const root = await callTradingApi('GetItem', body, oauthToken);
  return root.Item;
}

// ---------- GetSellerList: list active items for Seller A (for the "fetch" button) ----------
async function getSellerList(oauthToken, { pageNumber = 1, entriesPerPage = 200 } = {}) {
  const body = `
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>`;
  const root = await callTradingApi('GetMyeBaySelling', body, oauthToken);
  const items = root.ActiveList?.ItemArray?.Item
    ? (Array.isArray(root.ActiveList.ItemArray.Item) ? root.ActiveList.ItemArray.Item : [root.ActiveList.ItemArray.Item])
    : [];
  return {
    items,
    totalPages: Number(root.ActiveList?.PaginationResult?.TotalNumberOfPages || 1),
    totalEntries: Number(root.ActiveList?.PaginationResult?.TotalNumberOfEntries || items.length)
  };
}

// ---------- AddFixedPriceItem: create the listing on Seller B ----------
// `item` is the raw Item object returned by GetItem on Seller A.
// `policyIds` = { paymentPolicyId, fulfillmentPolicyId, returnPolicyId } for Seller B.
async function addFixedPriceItem(item, policyIds, oauthToken) {
  const pics = collectPictureUrls(item);
  const picsXml = pics.map(u => `<PictureURL>${escapeXml(u)}</PictureURL>`).join('');

  const specifics = collectItemSpecifics(item);
  const specificsXml = specifics.map(s => `
    <NameValueList>
      <Name>${escapeXml(s.name)}</Name>
      ${s.values.map(v => `<Value>${escapeXml(v)}</Value>`).join('')}
    </NameValueList>`).join('');

  const quantity = Number(item.Quantity || 1);
  const price = item.StartPrice?.['#text'] ?? item.StartPrice ?? item.BuyItNowPrice?.['#text'] ?? '0.00';
  const currency = item.StartPrice?.['@_currencyID'] || 'USD';

  const body = `
  <Item>
    <Title>${escapeXml(item.Title)}</Title>
    <Description><![CDATA[${item.Description || ''}]]></Description>
    <PrimaryCategory><CategoryID>${escapeXml(item.PrimaryCategory?.CategoryID)}</CategoryID></PrimaryCategory>
    <StartPrice currencyID="${currency}">${price}</StartPrice>
    <ConditionID>${escapeXml(item.ConditionID || '1000')}</ConditionID>
    <Country>${escapeXml(item.Country || 'US')}</Country>
    <Currency>${currency}</Currency>
    <DispatchTimeMax>${escapeXml(item.DispatchTimeMax || '1')}</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>${escapeXml(item.Location || '')}</Location>
    <Quantity>${quantity}</Quantity>
    ${item.SKU ? `<SKU>${escapeXml(item.SKU)}</SKU>` : ''}
    <PictureDetails>${picsXml}</PictureDetails>
    <ItemSpecifics>${specificsXml}</ItemSpecifics>
    <SellerProfiles>
      <SellerPaymentProfile><PaymentProfileID>${policyIds.paymentPolicyId}</PaymentProfileID></SellerPaymentProfile>
      <SellerReturnProfile><ReturnProfileID>${policyIds.returnPolicyId}</ReturnProfileID></SellerReturnProfile>
      <SellerShippingProfile><ShippingProfileID>${policyIds.fulfillmentPolicyId}</ShippingProfileID></SellerShippingProfile>
    </SellerProfiles>
  </Item>`;

  const root = await callTradingApi('AddFixedPriceItem', body, oauthToken);
  return {
    itemId: root.ItemID,
    fees: root.Fees,
    warnings: root.Ack === 'Warning' ? root.Errors : null
  };
}

// ---------- EndItem: close out the listing on Seller A ----------
async function endItem(itemId, oauthToken, reason = 'NotAvailable') {
  const body = `
  <ItemID>${escapeXml(itemId)}</ItemID>
  <EndingReason>${reason}</EndingReason>`;
  const root = await callTradingApi('EndItem', body, oauthToken);
  return { endTime: root.EndTime };
}

// ---------- Helpers to pull nested data out of GetItem's response shape ----------
function collectPictureUrls(item) {
  const urls = item.PictureDetails?.PictureURL;
  if (!urls) return [];
  return Array.isArray(urls) ? urls : [urls];
}

function collectItemSpecifics(item) {
  const list = item.ItemSpecifics?.NameValueList;
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map(nv => ({
    name: nv.Name,
    values: Array.isArray(nv.Value) ? nv.Value : [nv.Value]
  })).filter(nv => nv.name && nv.values.length);
}

module.exports = {
  getItem,
  getSellerList,
  addFixedPriceItem,
  endItem
};
