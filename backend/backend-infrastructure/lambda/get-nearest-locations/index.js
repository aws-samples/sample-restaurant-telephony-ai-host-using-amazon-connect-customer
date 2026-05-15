const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');

// Expand street abbreviations for speech-friendly output
const ADDR_ABBR = { Dr:'Drive',St:'Street',Ln:'Lane',Pkwy:'Parkway',Blvd:'Boulevard',Ave:'Avenue',Ct:'Court',Rd:'Road',Hwy:'Highway',Cir:'Circle',Pl:'Place',Ter:'Terrace',Trl:'Trail',Fwy:'Freeway',Expy:'Expressway' };
function expandAddress(s) { if (!s) return s; let r = s; for (const [a, f] of Object.entries(ADDR_ABBR)) r = r.replace(new RegExp(`\\b${a}\\b\\.?`, 'g'), f); return r; }
function expandAddressFields(o) { if (!o) return o; for (const f of ['address','street','label','homeAddress','locationName']) if (o[f]) o[f] = expandAddress(o[f]); return o; }

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE_NAME;

exports.handler = async (event) => {
  console.log('GetNearestLocations event:', JSON.stringify(event));

  try {
    // Extract parameters from query string or body
    const params = event.queryStringParameters || JSON.parse(event.body || '{}');
    const latitude = parseFloat(params.latitude);
    const longitude = parseFloat(params.longitude);
    const maxResults = parseInt(params.maxResults || '5');

    if (isNaN(latitude) || isNaN(longitude)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid latitude or longitude' })
      };
    }

    // Scan all locations (simple approach for small datasets ~10 stores)
    const scanResult = await docClient.send(new ScanCommand({
      TableName: LOCATIONS_TABLE
    }));

    const locations = scanResult.Items || [];

    // If no locations found, return empty array with message
    if (locations.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ 
          locations: [],
          message: 'No locations found. Please populate the Locations table with data.'
        })
      };
    }

    // Calculate distance for each location
    const locationsWithDistance = locations.map(location => {
      const distance = calculateDistance(
        latitude,
        longitude,
        location.latitude,
        location.longitude
      );
      return { ...location, distance };
    });

    // Sort by distance and limit results
    const nearestLocations = locationsWithDistance
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxResults)
      .map(loc => expandAddressFields(loc));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ locations: nearestLocations })
    };
  } catch (error) {
    console.error('Error getting nearest locations:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        error: 'Failed to get nearest locations',
        message: error.message 
      })
    };
  }
};

// Haversine formula to calculate distance between two coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}
