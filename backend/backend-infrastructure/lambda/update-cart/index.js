const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const CARTS_TABLE_NAME = process.env.CARTS_TABLE_NAME;

exports.handler = async (event) => {
  console.log('UpdateCart event:', JSON.stringify(event));

  try {
    const body = JSON.parse(event.body || '{}');
    const { customerId, action } = body;

    if (!customerId || !action) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          error: 'Missing required parameters: customerId and action',
          validActions: ['clear', 'remove_item', 'update_quantity', 'change_location']
        })
      };
    }

    const cartKey = { PK: `CUSTOMER#${customerId}` };
    const now = Math.floor(Date.now() / 1000);
    const ttl = now + (24 * 60 * 60);

    // ── Clear cart ──
    if (action === 'clear') {
      await docClient.send(new DeleteCommand({
        TableName: CARTS_TABLE_NAME,
        Key: cartKey
      }));

      return respond(200, { message: 'Cart cleared', items: [], itemCount: 0 });
    }

    // All other actions need the existing cart
    const cartResult = await docClient.send(new GetCommand({
      TableName: CARTS_TABLE_NAME,
      Key: cartKey
    }));

    if (!cartResult.Item || !cartResult.Item.items || cartResult.Item.items.length === 0) {
      return respond(400, { error: 'Cart is empty', items: [], itemCount: 0 });
    }

    let items = [...cartResult.Item.items];
    let locationId = cartResult.Item.locationId;

    // ── Remove item ──
    if (action === 'remove_item') {
      const { itemId } = body;
      if (!itemId) {
        return respond(400, { error: 'itemId is required for remove_item action' });
      }

      const before = items.length;
      items = items.filter(i => i.itemId !== itemId);

      if (items.length === before) {
        return respond(404, { error: `Item ${itemId} not found in cart` });
      }

      // If cart is now empty, delete it
      if (items.length === 0) {
        await docClient.send(new DeleteCommand({
          TableName: CARTS_TABLE_NAME,
          Key: cartKey
        }));
        return respond(200, { message: 'Item removed. Cart is now empty.', items: [], itemCount: 0 });
      }
    }

    // ── Update quantity ──
    if (action === 'update_quantity') {
      const { itemId, quantity } = body;
      if (!itemId || quantity === undefined) {
        return respond(400, { error: 'itemId and quantity are required for update_quantity action' });
      }

      const idx = items.findIndex(i => i.itemId === itemId);
      if (idx === -1) {
        return respond(404, { error: `Item ${itemId} not found in cart` });
      }

      if (quantity <= 0) {
        items.splice(idx, 1);
        if (items.length === 0) {
          await docClient.send(new DeleteCommand({
            TableName: CARTS_TABLE_NAME,
            Key: cartKey
          }));
          return respond(200, { message: 'Item removed. Cart is now empty.', items: [], itemCount: 0 });
        }
      } else {
        items[idx].quantity = quantity;
      }
    }

    // ── Change location ──
    if (action === 'change_location') {
      const { newLocationId } = body;
      if (!newLocationId) {
        return respond(400, { error: 'newLocationId is required for change_location action' });
      }
      locationId = newLocationId;
    }

    // Save updated cart
    const updatedCart = await docClient.send(new UpdateCommand({
      TableName: CARTS_TABLE_NAME,
      Key: cartKey,
      UpdateExpression: 'SET #items = :items, locationId = :locationId, updatedAt = :updatedAt, expiresAt = :expiresAt',
      ExpressionAttributeNames: { '#items': 'items' },
      ExpressionAttributeValues: {
        ':items': items,
        ':locationId': locationId,
        ':updatedAt': now,
        ':expiresAt': ttl
      },
      ReturnValues: 'ALL_NEW'
    }));

    const cart = updatedCart.Attributes;
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    return respond(200, {
      cart: {
        customerId: cart.customerId,
        locationId: cart.locationId,
        items,
        itemCount: items.length,
        subtotal: parseFloat(subtotal.toFixed(2))
      },
      message: `Cart updated (${action})`
    });

  } catch (error) {
    console.error('Error updating cart:', error);
    return respond(500, { error: 'Failed to update cart', message: error.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}
