const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const CUSTOMERS_TABLE_NAME = process.env.CUSTOMERS_TABLE_NAME;

exports.handler = async (event) => {
  console.log('GetCustomerProfile event:', JSON.stringify(event));

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

    // Use PK/SK structure: PK: CUSTOMER#{customerId}, SK: PROFILE
    const result = await docClient.send(new GetCommand({
      TableName: CUSTOMERS_TABLE_NAME,
      Key: {
        PK: `CUSTOMER#${customerId}`,
        SK: 'PROFILE'
      }
    }));

    if (!result.Item) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          customer: null,
          message: `Customer with ID ${customerId} not found. Please populate the Customers table with data.`
        })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ customer: result.Item })
    };
  } catch (error) {
    console.error('Error getting customer profile:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        error: 'Failed to get customer profile',
        message: error.message
      })
    };
  }
};
