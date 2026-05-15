const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

// Expand street abbreviations for speech-friendly output
const ADDR_ABBR = { Dr:'Drive',St:'Street',Ln:'Lane',Pkwy:'Parkway',Blvd:'Boulevard',Ave:'Avenue',Ct:'Court',Rd:'Road',Hwy:'Highway',Cir:'Circle',Pl:'Place',Ter:'Terrace',Trl:'Trail',Fwy:'Freeway',Expy:'Expressway' };
function expandAddress(s) { if (!s) return s; let r = s; for (const [a, f] of Object.entries(ADDR_ABBR)) r = r.replace(new RegExp(`\\b${a}\\b\\.?`, 'g'), f); return r; }
function expandAddressFields(o) { if (!o) return o; for (const f of ['address','street','label','homeAddress','locationName']) if (o[f]) o[f] = expandAddress(o[f]); return o; }

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const ORDERS_TABLE_NAME = process.env.ORDERS_TABLE_NAME;

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

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ orders: orders.map(o => expandAddressFields(o)) })
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
