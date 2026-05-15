const { LocationClient, SearchPlaceIndexForTextCommand } = require('@aws-sdk/client-location');

// Expand street abbreviations for speech-friendly output
const ADDR_ABBR = { Dr:'Drive',St:'Street',Ln:'Lane',Pkwy:'Parkway',Blvd:'Boulevard',Ave:'Avenue',Ct:'Court',Rd:'Road',Hwy:'Highway',Cir:'Circle',Pl:'Place',Ter:'Terrace',Trl:'Trail',Fwy:'Freeway',Expy:'Expressway' };
function expandAddress(s) { if (!s) return s; let r = s; for (const [a, f] of Object.entries(ADDR_ABBR)) r = r.replace(new RegExp(`\\b${a}\\b\\.?`, 'g'), f); return r; }

const locationClient = new LocationClient({});
const PLACE_INDEX_NAME = process.env.PLACE_INDEX_NAME;

exports.handler = async (event) => {
  console.log('GeocodeAddress event:', JSON.stringify(event));

  try {
    const params = event.queryStringParameters || JSON.parse(event.body || '{}');
    const address = params.address;

    if (!address) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Address parameter is required' })
      };
    }

    const result = await locationClient.send(new SearchPlaceIndexForTextCommand({
      IndexName: PLACE_INDEX_NAME,
      Text: address,
      MaxResults: 1
    }));

    if (!result.Results || result.Results.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          coordinates: null,
          message: 'No results found for the provided address'
        })
      };
    }

    const place = result.Results[0].Place;
    const coordinates = {
      latitude: place.Geometry.Point[1],
      longitude: place.Geometry.Point[0],
      label: expandAddress(place.Label),
      address: expandAddress(place.Label)
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ coordinates })
    };
  } catch (error) {
    console.error('Error geocoding address:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ 
        error: 'Failed to geocode address',
        message: error.message
      })
    };
  }
};
