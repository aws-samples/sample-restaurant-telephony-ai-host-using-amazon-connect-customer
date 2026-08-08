/**
 * Synthetic data generation for DynamoDB tables.
 *
 * Generates the Locations and Menu rows that the default deployment seeds, plus
 * the Customer and Order rows used only by the optional loyalty path in
 * populate-data.js. `generateCustomerData` takes a pre-computed `customerId`
 * along with the E.164 phone number and a synthetic email; the caller computes
 * the id before calling in here.
 *
 * Note: Math.random() is used for test data generation, not cryptography.
 */
const crypto = require('crypto');

const STREET_ABBREVIATIONS = {
  Dr: 'Drive', St: 'Street', Ln: 'Lane', Pkwy: 'Parkway',
  Blvd: 'Boulevard', Ave: 'Avenue', Ct: 'Court', Rd: 'Road',
  Hwy: 'Highway', Cir: 'Circle', Pl: 'Place', Ter: 'Terrace',
  Trl: 'Trail', Fwy: 'Freeway', Expy: 'Expressway',
};

function expandAddress(address) {
  if (!address) return address;
  let result = address;
  for (const [abbr, full] of Object.entries(STREET_ABBREVIATIONS)) {
    result = result.replace(new RegExp(`\\b${abbr}\\b\\.?`, 'g'), full);
  }
  return result;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sample(arr, n) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, n);
}

const MENU_CATEGORIES = {
  burgers: [
    { itemId: 'burger-classic', name: 'Classic Burger', description: 'Quarter pound beef patty with lettuce, tomato, onions, pickles', price: 5.99,
      customizations: [
        { id: 'no-onions', name: 'No Onions', price: 0, isRemoval: true },
        { id: 'no-pickles', name: 'No Pickles', price: 0, isRemoval: true },
        { id: 'extra-cheese', name: 'Extra Cheese', price: 0.50, isRemoval: false },
        { id: 'bacon', name: 'Add Bacon', price: 1.50, isRemoval: false },
      ] },
    { itemId: 'burger-deluxe', name: 'Deluxe Burger', description: 'Half pound beef patty with premium toppings', price: 8.99,
      customizations: [
        { id: 'no-onions', name: 'No Onions', price: 0, isRemoval: true },
        { id: 'extra-cheese', name: 'Extra Cheese', price: 0.50, isRemoval: false },
      ] },
  ],
  chicken: [
    { itemId: 'chicken-sandwich', name: 'Chicken Sandwich', description: 'Crispy or grilled chicken breast with lettuce and mayo', price: 6.49,
      customizations: [
        { id: 'grilled', name: 'Grilled Chicken', price: 0, isRemoval: false },
        { id: 'spicy', name: 'Spicy', price: 0, isRemoval: false },
        { id: 'no-mayo', name: 'No Mayo', price: 0, isRemoval: true },
      ] },
    { itemId: 'chicken-tenders', name: 'Chicken Tenders', description: '4 piece crispy chicken tenders', price: 7.99, customizations: [] },
  ],
  combos: [
    { itemId: 'combo-burger', name: 'Burger Combo', description: 'Classic burger with fries and drink', price: 8.99,
      customizations: [
        { id: 'large-fries', name: 'Large Fries', price: 1.00, isRemoval: false },
        { id: 'large-drink', name: 'Large Drink', price: 0.50, isRemoval: false },
      ] },
    { itemId: 'combo-chicken', name: 'Chicken Combo', description: 'Chicken sandwich with fries and drink', price: 9.49,
      customizations: [
        { id: 'grilled', name: 'Grilled Chicken', price: 0, isRemoval: false },
      ] },
  ],
  sides: [
    { itemId: 'fries', name: 'French Fries', description: 'Crispy golden fries', price: 2.99, customizations: [] },
    { itemId: 'onion-rings', name: 'Onion Rings', description: 'Crispy battered onion rings', price: 3.49, customizations: [] },
  ],
  drinks: [
    { itemId: 'soda', name: 'Fountain Drink', description: 'Choice of Coke, Sprite, or Dr Pepper', price: 1.99, customizations: [] },
    { itemId: 'shake', name: 'Milkshake', description: 'Vanilla, chocolate, or strawberry', price: 3.99, customizations: [] },
  ],
  desserts: [
    { itemId: 'ice-cream', name: 'Ice Cream Cone', description: 'Soft serve vanilla or chocolate', price: 1.99, customizations: [] },
  ],
};

function generateLocationData(place, businessName, locationId) {
  const addr = place.address;
  const coords = place.coordinates;
  const phone = `+1-${randInt(200, 999)}-${randInt(200, 999)}-${randInt(1000, 9999)}`;
  const hours = {
    monday: { open: '06:00', close: '22:00' }, tuesday: { open: '06:00', close: '22:00' },
    wednesday: { open: '06:00', close: '22:00' }, thursday: { open: '06:00', close: '22:00' },
    friday: { open: '06:00', close: '23:00' }, saturday: { open: '07:00', close: '23:00' },
    sunday: { open: '07:00', close: '22:00' },
  };
  return {
    PK: `LOCATION#${locationId}`, locationId, placeId: place.place_id,
    name: place.title, businessName,
    address: expandAddress(addr.label), street: expandAddress(addr.street),
    city: addr.city, state: addr.state, zipCode: addr.postal_code, country: addr.country,
    latitude: coords.latitude, longitude: coords.longitude,
    phone, hours, isActive: true,
    distance_meters: place.distance_meters || 0,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate the Customers profile row.
 *
 * Telephony adaptation: phoneNumber (E.164) is the primary caller-side
 * identity. customerId is the pre-computed pstn-<hash> (see
 * lib/customer-id.js computeCustomerId). email is synthesized for schema
 * parity with the reference `get-customer-profile` Lambda.
 *
 * @param {string} customerId  Pre-computed pstn-<16hex>.
 * @param {string} name        Display name from --user-name.
 * @param {string} phoneNumber E.164 from --user-phone.
 * @param {string} email       Synthesized <slug>@example.com.
 * @param {string} homeAddress
 * @param {[number, number]} homeCoordinates [lat, lon].
 */
function generateCustomerData(customerId, name, phoneNumber, email, homeAddress, homeCoordinates) {
  const tiers = [
    ['Bronze', randInt(0, 499)], ['Silver', randInt(500, 999)],
    ['Gold', randInt(1000, 1999)], ['Platinum', randInt(2000, 5000)],
  ];
  const [tier, points] = pick(tiers);
  return {
    PK: `CUSTOMER#${customerId}`, SK: 'PROFILE',
    customerId, name, email, phoneNumber,
    homeAddress, homeLatitude: homeCoordinates[0], homeLongitude: homeCoordinates[1],
    loyaltyTier: tier, loyaltyPoints: points, dietaryPreferences: [],
    createdAt: new Date().toISOString(),
  };
}

function generateMenuItems(locationId) {
  const items = [];
  for (const [category, categoryItems] of Object.entries(MENU_CATEGORIES)) {
    for (const item of categoryItems) {
      items.push({
        PK: `LOCATION#${locationId}#ITEM#${item.itemId}`,
        locationId, itemId: item.itemId, name: item.name,
        description: item.description, price: item.price,
        category: [category, 'All Items'], isAvailable: true,
        isCombo: category === 'combos',
        availableCustomizations: item.customizations,
        createdAt: new Date().toISOString(),
      });
    }
  }
  return items;
}

function generateOrders(customerId, nearbyLocations, numOrders = 5) {
  if (!nearbyLocations.length) return [];
  const allItems = Object.values(MENU_CATEGORIES).flat();
  const orders = [];

  for (let i = 0; i < numOrders; i++) {
    const location = pick(nearbyLocations);
    const daysAgo = randInt(1, 30);
    const hoursAgo = randInt(0, 23);
    const orderTime = new Date(Date.now() - (daysAgo * 86400000 + hoursAgo * 3600000));
    const orderId = `order-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const numItems = randInt(1, 3);
    const orderItems = [];
    let subtotal = 0;

    for (let j = 0; j < numItems; j++) {
      const item = pick(allItems);
      const numCustom = item.customizations.length ? randInt(0, Math.min(2, item.customizations.length)) : 0;
      const selectedCustomizations = sample(item.customizations, numCustom);
      let itemPrice = item.price;
      for (const c of selectedCustomizations) itemPrice += c.price;
      orderItems.push({
        itemId: item.itemId,
        name: item.name,
        price: item.price,
        quantity: 1,
        customizations: selectedCustomizations,
      });
      subtotal += itemPrice;
    }

    const tax = Math.round(subtotal * 0.08 * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    const ts = Math.floor(orderTime.getTime() / 1000);

    orders.push({
      PK: `CUSTOMER#${customerId}`, SK: `ORDER#${orderId}#${ts}`,
      GSI1PK: `LOCATION#${location.locationId}`, GSI1SK: `ORDER#${ts}`,
      customerId, orderId, locationId: location.locationId, locationName: location.name,
      items: orderItems, subtotal, tax, total, status: 'completed',
      estimatedReadyTime: new Date(orderTime.getTime() + 15 * 60000).toISOString(),
      createdAt: orderTime.toISOString(),
      completedAt: new Date(orderTime.getTime() + 20 * 60000).toISOString(),
    });
  }
  return orders;
}

module.exports = {
  generateLocationData,
  generateCustomerData,
  generateMenuItems,
  generateOrders,
  MENU_CATEGORIES,
};
