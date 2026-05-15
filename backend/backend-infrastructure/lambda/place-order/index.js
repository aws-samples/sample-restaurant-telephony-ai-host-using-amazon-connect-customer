const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

// Instantiated lazily via a module-level helper so tests can inject a mock
// DocumentClient via setDocClient(). Production code path hits the real client.
let _docClientOverride = null;
function getDocClient() {
  if (_docClientOverride) return _docClientOverride;
  const ddbClient = new DynamoDBClient({});
  return DynamoDBDocumentClient.from(ddbClient);
}
function setDocClient(client) {
  _docClientOverride = client;
}

const CARTS_TABLE_NAME = process.env.CARTS_TABLE_NAME;
const ORDERS_TABLE_NAME = process.env.ORDERS_TABLE_NAME;
const LOCATIONS_TABLE_NAME = process.env.LOCATIONS_TABLE_NAME;

// R9 baseline: telephony caller id shape (E.164 or empty for anonymous).
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(payload),
});

exports.handler = async (event) => {
  console.log('PlaceOrder event:', JSON.stringify(event));

  try {
    const body = JSON.parse(event.body || '{}');
    const { customerId, locationId } = body;

    // R9 baseline fields — accept on every call, defaults preserve older callers.
    // channel: any string; logged for observability.
    const channel =
      typeof body.channel === 'string' && body.channel.length > 0
        ? body.channel
        : 'web';
    // anonymousCaller: strictly boolean; `=== true` coercion.
    const anonymousCaller = body.anonymousCaller === true;
    // fromPhoneNumber: string; validated based on anonymousCaller flag.
    const fromPhoneNumberRaw =
      typeof body.fromPhoneNumber === 'string' ? body.fromPhoneNumber : '';

    if (!customerId || !locationId) {
      return jsonResponse(400, {
        error: 'Missing required parameters: customerId, locationId',
      });
    }

    // R9 validation: if anonymousCaller=false, fromPhoneNumber MUST match
    // E.164; if anonymousCaller=true, fromPhoneNumber MUST be empty.
    if (!anonymousCaller) {
      if (!E164_REGEX.test(fromPhoneNumberRaw)) {
        return jsonResponse(400, {
          error: 'Invalid fromPhoneNumber',
          message:
            'anonymousCaller=false requires fromPhoneNumber to match E.164 (^\\+[1-9]\\d{1,14}$).',
        });
      }
    } else {
      if (fromPhoneNumberRaw !== '') {
        return jsonResponse(400, {
          error: 'Invalid fromPhoneNumber',
          message:
            'anonymousCaller=true requires fromPhoneNumber to be empty.',
        });
      }
    }

    const docClient = getDocClient();

    // Get cart.
    const cart = await docClient.send(
      new GetCommand({
        TableName: CARTS_TABLE_NAME,
        Key: { PK: `CUSTOMER#${customerId}` },
      }),
    );

    if (!cart.Item || !cart.Item.items || cart.Item.items.length === 0) {
      return jsonResponse(400, {
        error: 'Cart is empty',
        message:
          'No items in cart. Please add items before placing an order.',
      });
    }

    // Get location for tax rate.
    const location = await docClient.send(
      new GetCommand({
        TableName: LOCATIONS_TABLE_NAME,
        Key: { PK: `LOCATION#${locationId}` },
      }),
    );

    if (!location.Item) {
      return jsonResponse(404, {
        error: 'Location not found',
        message: `Location ${locationId} not found. Please populate the Locations table with data.`,
      });
    }

    const taxRate = location.Item.taxRate || 0;

    // Totals.
    const subtotal = cart.Item.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    const orderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = Date.now();

    const order = {
      PK: `CUSTOMER#${customerId}`,
      SK: `ORDER#${orderId}#${timestamp}`,
      GSI1PK: `LOCATION#${locationId}`,
      GSI1SK: `ORDER#${timestamp}`,
      customerId,
      orderId,
      locationId,
      items: cart.Item.items,
      subtotal: parseFloat(subtotal.toFixed(2)),
      tax: parseFloat(tax.toFixed(2)),
      total: parseFloat(total.toFixed(2)),
      status: 'confirmed',
      timestamp,
      createdAt: new Date().toISOString(),
      // R9 baseline fields on the persisted order row.
      channel,
      anonymousCaller,
      fromPhoneNumber: fromPhoneNumberRaw,
    };

    await docClient.send(
      new PutCommand({ TableName: ORDERS_TABLE_NAME, Item: order }),
    );

    // Clear cart.
    await docClient.send(
      new DeleteCommand({
        TableName: CARTS_TABLE_NAME,
        Key: { PK: `CUSTOMER#${customerId}` },
      }),
    );

    return jsonResponse(200, {
      order,
      message: 'Order placed successfully',
    });
  } catch (error) {
    console.error('Error placing order:', error);
    return jsonResponse(500, {
      error: 'Failed to place order',
      message: error.message,
    });
  }
};

// Exported for unit tests (Task 2.5 / R9 validation coverage).
exports.setDocClient = setDocClient;
