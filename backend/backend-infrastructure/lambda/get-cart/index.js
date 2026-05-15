const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const CARTS_TABLE_NAME = process.env.CARTS_TABLE_NAME;

exports.handler = async (event) => {
  console.log('GetCart event:', JSON.stringify(event));

  try {
    const params = event.queryStringParameters || JSON.parse(event.body || '{}');
    const customerId = params.customerId;

    if (!customerId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'customerId parameter is required' })
      };
    }

    const result = await docClient.send(new GetCommand({
      TableName: CARTS_TABLE_NAME,
      Key: { PK: `CUSTOMER#${customerId}` }
    }));

    if (!result.Item || !result.Item.items || result.Item.items.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          cart: null,
          items: [],
          itemCount: 0,
          message: 'Cart is empty'
        })
      };
    }

    const cart = result.Item;
    const subtotal = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        cart: {
          customerId: cart.customerId,
          locationId: cart.locationId,
          items: cart.items,
          itemCount: cart.items.length,
          subtotal: parseFloat(subtotal.toFixed(2)),
          createdAt: cart.createdAt,
          updatedAt: cart.updatedAt
        }
      })
    };
  } catch (error) {
    console.error('Error getting cart:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Failed to get cart', message: error.message })
    };
  }
};
