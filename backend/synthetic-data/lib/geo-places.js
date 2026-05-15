/**
 * AWS Geo Places API integration for location discovery.
 *
 * Verbatim port from reference-project/backend/synthetic-data/lib/geo-places.js.
 * No changes needed — the telephony path uses Geo Places identically to the
 * reference (address/coords in, nearby places out).
 */
const { GeoPlacesClient, SearchTextCommand } = require('@aws-sdk/client-geo-places');

class GeoPlaces {
  constructor(region = 'us-east-1') {
    this.client = new GeoPlacesClient({ region });
  }

  /**
   * Convert an address string to [lat, lon] using geocoding.
   */
  async geocodeAddress(address) {
    try {
      const response = await this.client.send(
        new SearchTextCommand({
          QueryText: address,
          MaxResults: 1,
          BiasPosition: [-98.5795, 39.8283], // Center of contiguous US
        }),
      );
      const items = response.ResultItems || [];
      if (items.length > 0 && items[0].Position && items[0].Position.length >= 2) {
        // AWS returns [longitude, latitude]
        return [items[0].Position[1], items[0].Position[0]];
      }
      return null;
    } catch (err) {
      console.error(`❌ Geocoding error: ${err.message}`);
      return null;
    }
  }

  /**
   * Search for places near coordinates.
   */
  async searchNearbyPlaces(latitude, longitude, businessName, radiusMiles = 60, maxResults = 20) {
    const radiusMeters = Math.round(radiusMiles * 1609.34);
    try {
      const response = await this.client.send(
        new SearchTextCommand({
          QueryText: businessName,
          Filter: {
            Circle: {
              Center: [longitude, latitude], // AWS expects [lon, lat]
              Radius: radiusMeters,
            },
          },
          MaxResults: maxResults,
        }),
      );
      return (response.ResultItems || [])
        .map((item) => this._parsePlaceResult(item, latitude, longitude))
        .filter(Boolean);
    } catch (err) {
      const code = err.name || 'Unknown';
      console.error(`❌ AWS Geo Places API error (${code}): ${err.message}`);
      return [];
    }
  }

  _parsePlaceResult(item, centerLat, centerLon) {
    try {
      const position = item.Position || [];
      if (position.length < 2) return null;

      const addr = item.Address || {};
      const regionObj = addr.Region || {};
      const regionName = typeof regionObj === 'object' ? (regionObj.Name || '') : String(regionObj);
      const countryObj = addr.Country || {};
      const countryName = typeof countryObj === 'object' ? (countryObj.Name || '') : String(countryObj);
      const countryCode = typeof countryObj === 'object' ? (countryObj.Code3 || '') : '';
      const city = addr.Locality || '';
      const streetComponents = addr.StreetComponents || [];
      const addressNumber = addr.AddressNumber || '';

      let fullStreet = '';
      if (streetComponents.length > 0) {
        const comp = streetComponents[0];
        const baseName = comp.BaseName || '';
        const streetType = comp.Type || '';
        const placement = comp.TypePlacement || 'AfterBaseName';
        const separator = comp.TypeSeparator || ' ';
        fullStreet = placement === 'BeforeBaseName'
          ? (streetType ? `${streetType}${separator}${baseName}` : baseName)
          : (streetType ? `${baseName}${separator}${streetType}` : baseName);
        if (addressNumber) fullStreet = `${addressNumber} ${fullStreet}`;
      } else {
        fullStreet = addr.Street || '';
        if (addressNumber && fullStreet) fullStreet = `${addressNumber} ${fullStreet}`;
      }

      const addrParts = [fullStreet, city, `${regionName} ${addr.PostalCode || ''}`.trim(), countryName].filter(Boolean);
      const label = addrParts.join(', ');

      const distanceMeters = item.Distance != null
        ? item.Distance
        : (centerLat != null ? this._haversine(centerLat, centerLon, position[1], position[0]) : 0);

      return {
        place_id: item.PlaceId || '',
        title: item.Title || 'Unknown Location',
        address: {
          label,
          street: fullStreet,
          city,
          state: regionName,
          postal_code: addr.PostalCode || '',
          country: countryCode || countryName,
        },
        coordinates: { latitude: position[1], longitude: position[0] },
        distance_meters: distanceMeters,
        categories: item.Categories || [],
      };
    } catch (err) {
      console.warn(`⚠️  Warning: Failed to parse place result: ${err.message}`);
      return null;
    }
  }

  _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  formatDistance(meters) {
    return `${(meters / 1609.34).toFixed(1)} miles`;
  }
}

module.exports = { GeoPlaces };
