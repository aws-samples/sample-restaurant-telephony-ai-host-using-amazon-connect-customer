const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchGetCommand,
} = require('@aws-sdk/lib-dynamodb');

// Expand street abbreviations for speech-friendly output
const ADDR_ABBR = { Dr:'Drive',St:'Street',Ln:'Lane',Pkwy:'Parkway',Blvd:'Boulevard',Ave:'Avenue',Ct:'Court',Rd:'Road',Hwy:'Highway',Cir:'Circle',Pl:'Place',Ter:'Terrace',Trl:'Trail',Fwy:'Freeway',Expy:'Expressway' };
function expandAddress(s) { if (!s) return s; let r = s; for (const [a, f] of Object.entries(ADDR_ABBR)) r = r.replace(new RegExp(`\\b${a}\\b\\.?`, 'g'), f); return r; }
function expandAddressFields(o) { if (!o) return o; for (const f of ['address','street','label','homeAddress','locationName']) if (o[f]) o[f] = expandAddress(o[f]); return o; }

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const ORDERS_TABLE_NAME = process.env.ORDERS_TABLE_NAME;
const LOCATIONS_TABLE_NAME = process.env.LOCATIONS_TABLE_NAME;

/**
 * Look up the address fields for a set of locationIds and return a
 * `Map<locationId, {street, city, state, zipCode, name, businessName}>`.
 *
 * Uses BatchGetCommand which caps at 100 keys per request - we already
 * receive at most 5 orders so a single batch is always sufficient. If
 * the table name env var is missing or the call errors we return an
 * empty map so the caller falls back to the un-enriched response
 * rather than 500-ing on the agent.
 */
async function fetchLocationAddresses(locationIds) {
  const out = new Map();
  if (!LOCATIONS_TABLE_NAME) {
    console.warn('LOCATIONS_TABLE_NAME not set; skipping enrichment');
    return out;
  }
  const unique = Array.from(new Set(locationIds.filter(Boolean)));
  if (unique.length === 0) return out;

  try {
    const resp = await docClient.send(
      new BatchGetCommand({
        RequestItems: {
          [LOCATIONS_TABLE_NAME]: {
            Keys: unique.map((locationId) => ({
              PK: `LOCATION#${locationId}`,
            })),
            // Return only the fields we want to expose to the agent.
            // Skip placeId, coordinates, GSIs, etc.
            ProjectionExpression:
              'locationId, #n, businessName, address, street, city, #s, zipCode',
            ExpressionAttributeNames: {
              '#n': 'name',
              '#s': 'state',
            },
          },
        },
      }),
    );
    const items = resp?.Responses?.[LOCATIONS_TABLE_NAME] || [];
    for (const it of items) {
      if (!it || !it.locationId) continue;
      out.set(it.locationId, {
        street: expandAddress(it.street),
        address: expandAddress(it.address),
        city: it.city,
        state: it.state,
        zipCode: it.zipCode,
        name: it.name,
        businessName: it.businessName,
      });
    }
  } catch (err) {
    console.warn(
      'Locations BatchGet failed; returning orders without address enrichment',
      JSON.stringify({ err: err.message, locationIds: unique }),
    );
  }
  return out;
}

exports.handler = async (event) => {
  console.log('GetPreviousOrders event:', JSON.stringify(event));

  try {
    const params = event.queryStringParameters || JSON.parse(event.body || '{}');
    const customerId = params.customerId;
    const limit = parseInt(params.limit || '5');

    if (!customerId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'customerId parameter is required' })
      };
    }

    // Use PK/SK structure: PK: CUSTOMER#{customerId}, SK: ORDER#{orderId}#{timestamp}
    const result = await docClient.send(new QueryCommand({
      TableName: ORDERS_TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `CUSTOMER#${customerId}`,
        ':skPrefix': 'ORDER#'
      },
      ScanIndexForward: false, // Sort by SK descending (newest first)
      Limit: limit
    }));

    const orders = result.Items || [];

    if (orders.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          orders: [],
          message: `No orders found for customer ${customerId}. Please populate the Orders table with data.`
        })
      };
    }

    // Enrich each order row with the human-readable address fields from
    // the Locations table. The agent uses these to confirm a previously-
    // ordered location to the caller without speaking the opaque
    // locationId. Best-effort - if the BatchGet fails we still return
    // the orders, just without the address fields.
    const locationIds = orders.map((o) => o.locationId);
    const addressByLocationId = await fetchLocationAddresses(locationIds);

    const enriched = orders.map((o) => {
      const addr = addressByLocationId.get(o.locationId);
      const out = expandAddressFields({ ...o });
      if (addr) {
        // Merge in the address fields under canonical names. Do NOT
        // overwrite locationName when the row already has it (we
        // generated locationName at order time so it reflects the
        // brand at the moment of purchase).
        if (addr.street && !out.street) out.street = addr.street;
        if (addr.address && !out.address) out.address = addr.address;
        if (addr.city && !out.city) out.city = addr.city;
        if (addr.state && !out.state) out.state = addr.state;
        if (addr.zipCode && !out.zipCode) out.zipCode = addr.zipCode;
        if (addr.businessName && !out.businessName) out.businessName = addr.businessName;
      }
      return out;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ orders: enriched })
    };
  } catch (error) {
    console.error('Error getting previous orders:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        error: 'Failed to get previous orders',
        message: error.message
      })
    };
  }
};
