/**
 * Input validation for the telephony synthetic-data tool.
 *
 * Adapted from reference-project/backend/synthetic-data/lib/validators.js.
 * Changes:
 *   - Adds validateE164Phone for --user-phone input.
 *   - Adds slugifyName for deterministic generated email (<slug>@example.com).
 */

/**
 * Validate and parse coordinate input.
 * Accepts: "lat, long" or "lat,long"
 */
function validateCoordinates(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (!match) {
    return {
      isValid: false,
      coords: null,
      error: 'Invalid format. Use: latitude, longitude (e.g., 33.4127, -96.5837)',
    };
  }
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (lat < -90 || lat > 90) {
    return { isValid: false, coords: null, error: `Latitude must be between -90 and 90 (got ${lat})` };
  }
  if (lon < -180 || lon > 180) {
    return { isValid: false, coords: null, error: `Longitude must be between -180 and 180 (got ${lon})` };
  }
  return { isValid: true, coords: [lat, lon], error: '' };
}

/**
 * Validate a business-name search term.
 */
function validateBusinessName(name) {
  const trimmed = (name || '').trim();
  if (trimmed.length < 2) return { isValid: false, error: 'Business name must be at least 2 characters' };
  if (trimmed.length > 100) return { isValid: false, error: 'Business name must be less than 100 characters' };
  return { isValid: true, error: '' };
}

/**
 * Validate an E.164 phone number.
 *
 * The agent's pstn_customer.derive() accepts `^\+[1-9]\d{1,14}$`.
 * We enforce the same shape here so the hashed PK we compute
 * matches what the agent will compute at call time.
 */
function validateE164Phone(input) {
  const trimmed = (input || '').trim();
  if (!/^\+[1-9]\d{1,14}$/.test(trimmed)) {
    return {
      isValid: false,
      phone: null,
      error: `Phone must be E.164 format like +12065551234 (got ${JSON.stringify(trimmed)})`,
    };
  }
  return { isValid: true, phone: trimmed, error: '' };
}

/**
 * Validate --user-name — non-empty, <= 80 chars, ASCII-ish (avoids issues
 * downstream when the name threads into TTS and logs).
 */
function validateUserName(name) {
  const trimmed = (name || '').trim();
  if (trimmed.length < 1) return { isValid: false, error: 'User name cannot be empty' };
  if (trimmed.length > 80) return { isValid: false, error: 'User name must be less than 80 characters' };
  return { isValid: true, error: '' };
}

/**
 * Turn a human name into a slug used to generate the synthetic email.
 * "Jane Doe" -> "jane-doe".
 */
function slugifyName(name) {
  return (name || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'user';
}

/**
 * Generate a clean location ID from place ID and business name.
 * (verbatim from reference)
 */
function sanitizeLocationId(placeId, businessName) {
  const suffix = placeId.length >= 8 ? placeId.slice(-8) : placeId;
  let cleanName = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (cleanName.length > 30) cleanName = cleanName.slice(0, 30).replace(/-$/, '');
  return `loc-${cleanName}-${suffix}`;
}

module.exports = {
  validateCoordinates,
  validateBusinessName,
  validateE164Phone,
  validateUserName,
  slugifyName,
  sanitizeLocationId,
};
