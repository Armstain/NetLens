const assert = require('assert');
const {
  normalizeText,
  extractNumeric,
  indexResponseBody,
  findDataSources,
} = require('./provenance.js');

// 1. Numeric normalization tests
assert.strictEqual(extractNumeric('৳89,999'), 89999);
assert.strictEqual(extractNumeric('$1,299.00'), 1299);
assert.strictEqual(extractNumeric('12.5%'), 12.5);
assert.strictEqual(extractNumeric('89999'), 89999);
assert.strictEqual(extractNumeric(89999), 89999);
assert.strictEqual(extractNumeric('not a number'), null);

// 2. Exact value match & JSON path
const req1 = {
  id: 1,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/products/123',
  status: 200,
  contentType: 'application/json',
  startedAt: 1000,
  responseBody: JSON.stringify({
    data: {
      product: {
        id: 123,
        name: 'iPhone 15',
        price: 89999,
        inStock: true,
        image: 'https://cdn.example.com/p123.jpg',
      },
    },
  }),
};

const resExact = findDataSources(
  { text: 'iPhone 15', tag: 'h1', classes: ['title'] },
  [req1]
);
assert.strictEqual(resExact.candidates.length, 1);
assert.strictEqual(resExact.candidates[0].confidence, 'High');
assert.strictEqual(resExact.candidates[0].jsonPath, 'data.product.name');
assert.strictEqual(resExact.candidates[0].matchReason, 'exact-value');

// 3. Formatted numeric match (৳89,999 -> 89999)
const resNumeric = findDataSources(
  { text: '৳89,999', tag: 'span', classes: ['price'], nearbyText: 'Price: ' },
  [req1]
);
assert.strictEqual(resNumeric.candidates.length, 1);
assert.strictEqual(resNumeric.candidates[0].confidence, 'Medium');
assert.strictEqual(resNumeric.candidates[0].jsonPath, 'data.product.price');
assert.strictEqual(resNumeric.candidates[0].apiValue, 89999);
assert.strictEqual(resNumeric.candidates[0].matchReason, 'numeric-match');

// Formatted numeric match WITH sibling corroboration (in card with 'iPhone 15') -> High
const resNumericCorroborated = findDataSources(
  {
    text: '৳89,999',
    tag: 'span',
    classes: ['price'],
    nearbyText: 'Price: ',
    containerTexts: ['iPhone 15', '৳89,999'],
  },
  [req1]
);
assert.strictEqual(resNumericCorroborated.candidates[0].confidence, 'High');

// Generic non-distinct number (e.g. 63 or 10) -> Low
const reqGeneric = {
  id: 10,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/stats',
  status: 200,
  contentType: 'application/json',
  startedAt: 1150,
  responseBody: JSON.stringify({
    count: 63,
    limit: 63,
    page: 1,
    total: 200,
  }),
};
const resGeneric = findDataSources(
  { text: '63', tag: 'span' },
  [reqGeneric]
);
assert.strictEqual(resGeneric.candidates[0].confidence, 'Low');

// 4. Attribute match (image src)
const resAttr = findDataSources(
  { text: '', tag: 'img', attributes: { src: 'https://cdn.example.com/p123.jpg' } },
  [req1]
);
assert.strictEqual(resAttr.candidates.length, 1);
assert.strictEqual(resAttr.candidates[0].confidence, 'High');
assert.strictEqual(resAttr.candidates[0].jsonPath, 'data.product.image');
assert.strictEqual(resAttr.candidates[0].matchReason, 'attribute-match');

// 5. Combined fields (firstName + lastName -> 'John Doe')
const req2 = {
  id: 2,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/user/profile',
  status: 200,
  contentType: 'application/json',
  startedAt: 1100,
  responseBody: JSON.stringify({
    user: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
    },
  }),
};

const resCombined = findDataSources(
  { text: 'John Doe', tag: 'span', classes: ['author-name'] },
  [req2]
);
assert.strictEqual(resCombined.candidates.length, 1);
assert.strictEqual(resCombined.candidates[0].confidence, 'High');
assert.strictEqual(resCombined.candidates[0].matchReason, 'combined-fields');
assert.strictEqual(resCombined.candidates[0].apiValue, 'John Doe');

// 6. Duplicate values across multiple responses: disambiguated by container context
const reqCatalogA = {
  id: 3,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/catalog/phones',
  status: 200,
  contentType: 'application/json',
  startedAt: 1200,
  responseBody: JSON.stringify({
    items: [
      { id: 101, name: 'Budget Phone', price: 150 },
      { id: 102, name: 'Pro Phone', price: 999 },
    ],
  }),
};

const reqCatalogB = {
  id: 4,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/catalog/accessories',
  status: 200,
  contentType: 'application/json',
  startedAt: 1300,
  responseBody: JSON.stringify({
    items: [
      { id: 201, name: 'Case', price: 150 }, // same price: 150!
    ],
  }),
};

// User clicked '150' inside a card that also contains 'Budget Phone'
const resDuplicate = findDataSources(
  {
    text: '$150',
    tag: 'span',
    classes: ['price'],
    nearbyText: 'Price: ',
    containerTexts: ['Budget Phone', '$150', 'Add to Cart'],
  },
  [reqCatalogA, reqCatalogB]
);

assert.ok(resDuplicate.candidates.length >= 2);
// reqCatalogA should rank higher than reqCatalogB because 'Budget Phone' corroborates it
assert.strictEqual(resDuplicate.candidates[0].requestId, 3);
assert.strictEqual(resDuplicate.candidates[0].jsonPath, 'items[0].price');
assert.strictEqual(resDuplicate.candidates[0].confidence, 'High');
assert.ok(resDuplicate.candidates[0].confidenceScore > resDuplicate.candidates[1].confidenceScore);

// 7. WebSocket frame payload matching
const wsReq = {
  id: 5,
  kind: 'wsframe',
  wsId: 'ws1',
  dir: 'recv',
  url: 'wss://live.example.com/feed',
  startedAt: 1400,
  data: JSON.stringify({ ticker: 'BTC', price: 65432.1 }),
};

const resWs = findDataSources(
  { text: '65,432.10', tag: 'td', classes: ['crypto-price'] },
  [wsReq]
);
assert.strictEqual(resWs.candidates.length, 1);
assert.strictEqual(resWs.candidates[0].sourceType, 'websocket');
assert.strictEqual(resWs.candidates[0].jsonPath, 'price');

// 8. No matching source & SSR detection fallback
const resNoMatch = findDataSources(
  { text: 'Static Footer Copyright 2026', inInitialHtml: false },
  [req1, req2]
);
assert.strictEqual(resNoMatch.candidates.length, 0);
assert.ok(resNoMatch.fallback.includes('No matching network source found'));

const resSsr = findDataSources(
  { text: 'Server Rendered Title', inInitialHtml: true },
  [req1, req2]
);
assert.strictEqual(resSsr.candidates.length, 0);
assert.ok(resSsr.fallback.includes('Server-rendered / initial document'));

// 9. Edge Case: Transformed data mismatch (API: 100, UI: ৳12,340 - must NOT match)
const reqTransformed = {
  id: 6,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/item',
  status: 200,
  contentType: 'application/json',
  startedAt: 1500,
  responseBody: JSON.stringify({ price: 100 }),
};
const resTransformed = findDataSources(
  { text: '৳12,340', tag: 'span', classes: ['price'] },
  [reqTransformed]
);
assert.strictEqual(resTransformed.candidates.length, 0);

// 10. Edge Case: European numeric formatting (1.299,50 € -> 1299.5, 12,50 € -> 12.5)
assert.strictEqual(extractNumeric('1.299,50 €'), 1299.5);
assert.strictEqual(extractNumeric('12,50 €'), 12.5);
const reqEuro = {
  id: 7,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/euro-item',
  status: 200,
  contentType: 'application/json',
  startedAt: 1600,
  responseBody: JSON.stringify({ price: 1299.5 }),
};
const resEuro = findDataSources(
  { text: '1.299,50 €', tag: 'span', nearbyText: 'Price: ' },
  [reqEuro]
);
assert.strictEqual(resEuro.candidates.length, 1);
assert.strictEqual(resEuro.candidates[0].apiValue, 1299.5);

// 11. Edge Case: Boolean formatting (inStock: true -> 'Available' / 'In stock')
const resBool = findDataSources(
  { text: 'Available', tag: 'span', classes: ['status-badge'] },
  [req1]
);
assert.strictEqual(resBool.candidates.length, 1);
assert.strictEqual(resBool.candidates[0].jsonPath, 'data.product.inStock');
assert.strictEqual(resBool.candidates[0].apiValue, true);

// 12. Edge Case: Date formatting (2026-09-21T10:00:00Z -> 'Sep 21, 2026' or '2026-09-21')
const reqDate = {
  id: 8,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/event',
  status: 200,
  contentType: 'application/json',
  startedAt: 1700,
  responseBody: JSON.stringify({ eventDate: '2026-09-21T10:00:00Z' }),
};
const resDate = findDataSources(
  { text: '2026-09-21', tag: 'span' },
  [reqDate]
);
assert.strictEqual(resDate.candidates.length, 1);
assert.strictEqual(resDate.candidates[0].jsonPath, 'eventDate');

// 13. Deep & Large Search API response (facets + 100s of primitives before hotels)
const reqHotelSearch = {
  id: 20,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/hotels/search',
  status: 200,
  contentType: 'application/json',
  startedAt: 2000,
  responseBody: JSON.stringify({
    session: { id: 'sess-abc-123', city: 'Dubai' },
    filters: {
      amenities: Array.from({ length: 80 }, (_, i) => ({ id: i, name: 'Amenity ' + i, count: i * 2 })),
      neighborhoods: Array.from({ length: 40 }, (_, i) => ({ id: i, name: 'District ' + i })),
    },
    data: {
      results: [
        {
          id: 101,
          name: 'Marina Walk Gem Modern Apartments',
          rates: [{ total: 36338.17 }]
        },
        {
          id: 102,
          name: 'Dubai Marine Beach Resort & Spa',
          rates: [{
            customerPrice: 23890.03,
            purchasePrice: 22087.03,
            supplierPrice: 180.09
          }]
        },
        {
          id: 103,
          name: 'Dubai Marriott Harbour Hotel & Suites',
          rates: [{ total: 10377.68 }]
        }
      ]
    }
  }),
};

// 14. Title substring & prefix matching ('Marine Beach Resort & Spa' ↔ 'Dubai Marine Beach Resort & Spa')
const resTitleSub = findDataSources(
  { text: 'Marine Beach Resort & Spa', tag: 'h3', classes: ['hotel-title'] },
  [reqHotelSearch]
);
assert.strictEqual(resTitleSub.candidates.length, 1);
assert.strictEqual(resTitleSub.candidates[0].jsonPath, 'data.results[1].name');
assert.strictEqual(resTitleSub.candidates[0].apiValue, 'Dubai Marine Beach Resort & Spa');

// Truncated title with ellipsis ('Marriott Harbour Hotel...' ↔ 'Dubai Marriott Harbour Hotel & Suites')
const resTitleTrunc = findDataSources(
  { text: 'Marriott Harbour Hotel...', tag: 'h3' },
  [reqHotelSearch]
);
assert.strictEqual(resTitleTrunc.candidates.length, 1);
assert.strictEqual(resTitleTrunc.candidates[0].jsonPath, 'data.results[2].name');

// 15. Price match with currency and deep path
const resHotelPrice = findDataSources(
  {
    text: '৳ 23,890.03',
    tag: 'h4',
    classes: ['font-tgmono', 'font-bold'],
    containerTexts: ['Marine Beach Resort & Spa', 'Standard Double or Twin Room', '৳ 23,890.03'],
  },
  [reqHotelSearch]
);
assert.strictEqual(resHotelPrice.candidates.length, 1);
assert.strictEqual(resHotelPrice.candidates[0].jsonPath, 'data.results[1].rates[0].customerPrice');
assert.strictEqual(resHotelPrice.candidates[0].apiValue, 23890.03);

// 16. Container entity fallback: client-side marked up price (UI: ৳ 23,890.03, API only has purchasePrice: 22087.03)
const reqMarkupOnly = {
  id: 21,
  kind: 'fetch',
  method: 'GET',
  url: 'https://api.example.com/hotels/b2b-search',
  status: 200,
  contentType: 'application/json',
  startedAt: 2100,
  responseBody: JSON.stringify({
    data: {
      results: [
        {
          id: 202,
          name: 'Dubai Marine Beach Resort & Spa',
          rates: [{
            purchasePrice: 22087.03,
            supplierPrice: 180.09
          }]
        }
      ]
    }
  }),
};

const resMarkup = findDataSources(
  {
    text: '৳ 23,890.03',
    tag: 'h4',
    classes: ['font-tgmono', 'font-bold'],
    containerTexts: ['Marine Beach Resort & Spa', 'Standard Double or Twin Room', '৳ 23,890.03'],
  },
  [reqMarkupOnly]
);
assert.strictEqual(resMarkup.candidates.length, 1);
assert.strictEqual(resMarkup.candidates[0].matchReason, 'container-entity');
assert.strictEqual(resMarkup.candidates[0].jsonPath, 'data.results[0].rates[0].purchasePrice');
assert.strictEqual(resMarkup.candidates[0].apiValue, 22087.03);

// 17. Composite Container / Card Inspection (Card fed by multiple APIs)
const reqAds = {
  id: 22,
  kind: 'fetch',
  method: 'POST',
  url: 'https://api.example.com/marketing/advertisement-list',
  status: 200,
  contentType: 'application/json',
  startedAt: 1900,
  responseBody: JSON.stringify({
    advertisements: [
      { id: 'ad-1', supplierName: 'Expedia - Sandbox', tag: 'Connected Suppliers' }
    ]
  })
};

const compositeCardContext = {
  isContainer: true,
  tag: 'div',
  classes: ['hotel-card'],
  text: 'Marine Beach Resort & Spa Connected Suppliers Expedia - Sandbox ৳ 23,890.03',
  subElements: [
    { text: 'Marine Beach Resort & Spa', tag: 'h3' },
    { text: '৳ 23,890.03', tag: 'h4' },
    { text: 'Expedia - Sandbox', tag: 'span' },
  ],
};

const resComposite = findDataSources(compositeCardContext, [reqHotelSearch, reqAds]);
assert.strictEqual(resComposite.isContainer, true);
assert.strictEqual(resComposite.contributingRequests.length, 2);
// reqHotelSearch should contribute 2 fields
const hotelContrib = resComposite.contributingRequests.find(r => r.requestId === 20);
assert.ok(hotelContrib);
assert.strictEqual(hotelContrib.matchCount, 2);
assert.strictEqual(hotelContrib.confidence, 'High');
// reqAds should contribute 1 field
const adsContrib = resComposite.contributingRequests.find(r => r.requestId === 22);
assert.ok(adsContrib);
assert.strictEqual(adsContrib.matchCount, 1);

console.log('All provenance tests passed!');


