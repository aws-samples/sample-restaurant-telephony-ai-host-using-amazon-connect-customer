const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, BatchGetCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const MENU_TABLE_NAME = process.env.MENU_TABLE_NAME;
const CARTS_TABLE_NAME = process.env.CARTS_TABLE_NAME;

exports.handler = async (event) => {
  console.log('[DEBUG] AddToCart event:', JSON.stringify(event));

  try {
    const body = JSON.parse(event.body || '{}');
    const { customerId, locationId, items } = body;

    console.log('[DEBUG] Parsed request - customerId:', customerId, 'locationId:', locationId, 'items count:', items?.length);

    // Validate required parameters
    if (!customerId || !locationId || !items || !Array.isArray(items) || items.length === 0) {
      console.log('[DEBUG] Validation failed - missing required parameters');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ 
          error: 'Missing required parameters: customerId, locationId, and items array (must contain at least one item)' 
        })
      };
    }

    // Validate each item has required fields
    for (let i = 0; i < items.length; i++) {
      if (!items[i].itemId || !items[i].quantity) {
        console.log('[DEBUG] Item validation failed at index', i, '- missing itemId or quantity');
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ 
            error: `Item at index ${i} is missing required fields: itemId and quantity` 
          })
        };
      }
    }

    console.log('[DEBUG] Starting batch item validation for', items.length, 'items');

    // Batch get all menu items to validate
    const menuKeys = items.map(item => ({
      PK: `LOCATION#${locationId}#ITEM#${item.itemId}`
    }));

    const batchGetResult = await docClient.send(new BatchGetCommand({
      RequestItems: {
        [MENU_TABLE_NAME]: {
          Keys: menuKeys
        }
      }
    }));

    console.log('[DEBUG] BatchGet returned', batchGetResult.Responses[MENU_TABLE_NAME]?.length || 0, 'items');

    // Create a map of itemId to menu item for quick lookup
    const menuItemsMap = {};
    (batchGetResult.Responses[MENU_TABLE_NAME] || []).forEach(item => {
      menuItemsMap[item.itemId] = item;
    });

    // Validate each item and categorize as success or failure
    const itemsAdded = [];
    const itemsFailed = [];

    for (const requestItem of items) {
      const menuItem = menuItemsMap[requestItem.itemId];
      
      if (!menuItem) {
        console.log('[DEBUG] Item not found:', requestItem.itemId);
        itemsFailed.push({
          itemId: requestItem.itemId,
          quantity: requestItem.quantity,
          name: 'Unknown',
          error: 'Item no longer exists in this location'
        });
        continue;
      }

      if (!menuItem.isAvailable) {
        console.log('[DEBUG] Item not available:', requestItem.itemId, '-', menuItem.name);
        itemsFailed.push({
          itemId: requestItem.itemId,
          quantity: requestItem.quantity,
          name: menuItem.name,
          error: 'Item not available'
        });
        continue;
      }

      // Item is valid
      console.log('[DEBUG] Item validated successfully:', requestItem.itemId, '-', menuItem.name);
      itemsAdded.push({
        itemId: requestItem.itemId,
        name: menuItem.name,
        price: menuItem.price,
        quantity: requestItem.quantity
      });
    }

    console.log('[DEBUG] Validation complete - Added:', itemsAdded.length, 'Failed:', itemsFailed.length);

    // If no items can be added, return error
    if (itemsAdded.length === 0) {
      console.log('[DEBUG] No valid items to add to cart');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ 
          error: 'No valid items to add to cart',
          itemsFailed,
          message: `0 item(s) added, ${itemsFailed.length} item(s) failed`
        })
      };
    }

    // Get or create cart
    console.log('[DEBUG] Fetching existing cart for customer:', customerId);
    const cart = await docClient.send(new GetCommand({
      TableName: CARTS_TABLE_NAME,
      Key: {
        PK: `CUSTOMER#${customerId}`
      }
    }));

    const now = Math.floor(Date.now() / 1000);
    const ttl = now + (24 * 60 * 60); // 24 hours from now

    if (!cart.Item) {
      // Create new cart with all valid items
      console.log('[DEBUG] Creating new cart with', itemsAdded.length, 'items');
      const newCart = {
        PK: `CUSTOMER#${customerId}`,
        customerId,
        locationId,
        items: itemsAdded,
        createdAt: now,
        updatedAt: now,
        expiresAt: ttl
      };

      await docClient.send(new PutCommand({
        TableName: CARTS_TABLE_NAME,
        Item: newCart
      }));

      console.log('[DEBUG] New cart created successfully');

      const subtotal = itemsAdded.reduce((sum, item) => sum + (item.price * item.quantity), 0);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ 
          cart: { ...newCart, itemCount: itemsAdded.length, subtotal: parseFloat(subtotal.toFixed(2)) },
          itemsAdded,
          itemsFailed,
          message: `Added ${itemsAdded.length} item(s)${itemsFailed.length > 0 ? `, ${itemsFailed.length} item(s) failed` : ''}`
        })
      };
    }

    // Update existing cart - merge items
    console.log('[DEBUG] Updating existing cart');
    const existingItems = cart.Item.items || [];
    let updatedItems = [...existingItems];

    for (const newItem of itemsAdded) {
      const existingIndex = updatedItems.findIndex(i => i.itemId === newItem.itemId);
      
      if (existingIndex >= 0) {
        // Update quantity of existing item
        console.log('[DEBUG] Updating quantity for existing item:', newItem.itemId, 'from', updatedItems[existingIndex].quantity, 'to', updatedItems[existingIndex].quantity + newItem.quantity);
        updatedItems[existingIndex].quantity += newItem.quantity;
      } else {
        // Add new item to cart
        console.log('[DEBUG] Adding new item to cart:', newItem.itemId);
        updatedItems.push(newItem);
      }
    }

    const updatedCart = await docClient.send(new UpdateCommand({
      TableName: CARTS_TABLE_NAME,
      Key: {
        PK: `CUSTOMER#${customerId}`
      },
      UpdateExpression: 'SET #items = :items, updatedAt = :updatedAt, expiresAt = :expiresAt',
      ExpressionAttributeNames: {
        '#items': 'items'
      },
      ExpressionAttributeValues: {
        ':items': updatedItems,
        ':updatedAt': now,
        ':expiresAt': ttl
      },
      ReturnValues: 'ALL_NEW'
    }));

    console.log('[DEBUG] Cart updated successfully');

    const subtotal = updatedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        cart: { ...updatedCart.Attributes, itemCount: updatedItems.length, subtotal: parseFloat(subtotal.toFixed(2)) },
        itemsAdded,
        itemsFailed,
        message: `Added ${itemsAdded.length} item(s)${itemsFailed.length > 0 ? `, ${itemsFailed.length} item(s) failed` : ''}`
      })
    };
  } catch (error) {
    console.error('[ERROR] Error adding to cart:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        error: 'Failed to add items to cart',
        message: error.message
      })
    };
  }
};
