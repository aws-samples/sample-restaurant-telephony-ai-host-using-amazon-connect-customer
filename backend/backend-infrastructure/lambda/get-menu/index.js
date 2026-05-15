const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const MENU_TABLE_NAME = process.env.MENU_TABLE_NAME;

exports.handler = async (event) => {
  console.log('GetMenu event:', JSON.stringify(event));

  try {
    const params = event.queryStringParameters || JSON.parse(event.body || '{}');
    const locationId = params.locationId;

    if (!locationId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'locationId parameter is required' })
      };
    }

    // Use Scan with filter since PK format is LOCATION#{locationId}#ITEM#{itemId}
    const result = await docClient.send(new ScanCommand({
      TableName: MENU_TABLE_NAME,
      FilterExpression: 'begins_with(PK, :pkPrefix)',
      ExpressionAttributeValues: {
        ':pkPrefix': `LOCATION#${locationId}#ITEM#`
      }
    }));

    const menuItems = result.Items || [];

    if (menuItems.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          menuItems: [],
          message: `No menu items found for location ${locationId}. Please populate the Menu table with data.`
        })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ menuItems })
    };
  } catch (error) {
    console.error('Error getting menu:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        error: 'Failed to get menu',
        message: error.message
      })
    };
  }
};
