const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { LocationClient, CalculateRouteCommand } = require('@aws-sdk/client-location');

// Expand street abbreviations for speech-friendly output
const ADDR_ABBR = { Dr:'Drive',St:'Street',Ln:'Lane',Pkwy:'Parkway',Blvd:'Boulevard',Ave:'Avenue',Ct:'Court',Rd:'Road',Hwy:'Highway',Cir:'Circle',Pl:'Place',Ter:'Terrace',Trl:'Trail',Fwy:'Freeway',Expy:'Expressway' };
function expandAddress(s) { if (!s) return s; let r = s; for (const [a, f] of Object.entries(ADDR_ABBR)) r = r.replace(new RegExp(`\\b${a}\\b\\.?`, 'g'), f); return r; }
function expandAddressFields(o) { if (!o) return o; for (const f of ['address','street','label','homeAddress','locationName']) if (o[f]) o[f] = expandAddress(o[f]); return o; }

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const locationClient = new LocationClient({});

const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE_NAME;
const ROUTE_CALCULATOR_NAME = process.env.ROUTE_CALCULATOR_NAME;

exports.handler = async (event) => {
  console.log('FindLocationAlongRoute event:', JSON.stringify(event));

  try {
    const params = event.queryStringParameters || JSON.parse(event.body || '{}');
    const startLatitude = parseFloat(params.startLatitude);
    const startLongitude = parseFloat(params.startLongitude);
    const endLatitude = parseFloat(params.endLatitude);
    const endLongitude = parseFloat(params.endLongitude);
    const maxDetourMinutes = parseInt(params.maxDetourMinutes || '10');

    if (isNaN(startLatitude) || isNaN(startLongitude) || isNaN(endLatitude) || isNaN(endLongitude)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid coordinates' })
      };
    }

    // Calculate main route
    const mainRoute = await locationClient.send(new CalculateRouteCommand({
      CalculatorName: ROUTE_CALCULATOR_NAME,
      DeparturePosition: [startLongitude, startLatitude],
      DestinationPosition: [endLongitude, endLatitude]
    }));

    const mainRouteDuration = mainRoute.Summary.DurationSeconds / 60; // Convert to minutes

    // Scan all locations
    const scanResult = await docClient.send(new ScanCommand({
      TableName: LOCATIONS_TABLE
    }));

    const locations = scanResult.Items || [];

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

    // Calculate detour for each location
    const locationsWithDetour = await Promise.all(
      locations.map(async (location) => {
        try {
          // Route from start to location
          const routeToLocation = await locationClient.send(new CalculateRouteCommand({
            CalculatorName: ROUTE_CALCULATOR_NAME,
            DeparturePosition: [startLongitude, startLatitude],
            DestinationPosition: [location.longitude, location.latitude]
          }));

          // Route from location to end
          const routeFromLocation = await locationClient.send(new CalculateRouteCommand({
            CalculatorName: ROUTE_CALCULATOR_NAME,
            DeparturePosition: [location.longitude, location.latitude],
            DestinationPosition: [endLongitude, endLatitude]
          }));

          const totalDuration = 
            (routeToLocation.Summary.DurationSeconds + routeFromLocation.Summary.DurationSeconds) / 60;
          const detourMinutes = totalDuration - mainRouteDuration;

          return { ...location, detourMinutes };
        } catch (error) {
          console.error("Error calculating route for location %s:", location.locationId, error);
          return null;
        }
      })
    );

    // Filter out failed calculations and locations with excessive detour
    const validLocations = locationsWithDetour
      .filter(loc => loc !== null && loc.detourMinutes <= maxDetourMinutes)
      .sort((a, b) => a.detourMinutes - b.detourMinutes)
      .map(loc => expandAddressFields(loc));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        locations: validLocations,
        mainRouteDurationMinutes: mainRouteDuration
      })
    };
  } catch (error) {
    console.error('Error finding location along route:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        error: 'Failed to find location along route',
        message: error.message
      })
    };
  }
};
