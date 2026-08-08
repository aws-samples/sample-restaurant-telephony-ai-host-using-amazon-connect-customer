#!/usr/bin/env node
/**
 * Synthetic Data Population for the Telephony Voice Ordering Agent.
 *
 * Seeds the Locations and Menu tables with realistic data discovered through
 * the Amazon Location Service Geo Places API. Table names are read from
 * cdk-outputs/cn-ddb.json, keyed on the logical stack id `DynamoDBStack`.
 * The --non-interactive flag skips all prompts so deploy-all.sh can run this
 * unattended.
 *
 * Supplying --user-phone additionally seeds a single loyalty Customer row and
 * some order history. That path is NOT exercised by the default deployment and
 * currently requires an SSM pepper parameter that no stack in this project
 * provisions (see lib/customer-id.js).
 *
 * Usage (interactive):
 *   node populate-data.js --company-name "Example Cafe"
 *
 * Usage (non-interactive, driven by deploy-all.sh):
 *   node populate-data.js \
 *     --location "Dallas, TX" \
 *     --business-name "burgers" \
 *     --deployment-prefix qsr-cn \
 *     --non-interactive
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const {
  validateCoordinates,
  validateBusinessName,
  validateE164Phone,
  validateUserName,
  slugifyName,
  sanitizeLocationId,
} = require('./lib/validators');
const { GeoPlaces } = require('./lib/geo-places');
const {
  generateLocationData,
  generateCustomerData,
  generateMenuItems,
  generateOrders,
} = require('./lib/data-generator');
const { DynamoDB } = require('./lib/dynamodb-client');
const { loadPepper, computeCustomerId } = require('./lib/customer-id');

const C = {
  BLUE: '\x1b[34m', GREEN: '\x1b[32m', YELLOW: '\x1b[33m',
  RED: '\x1b[31m', CYAN: '\x1b[36m', NC: '\x1b[0m',
};

const header = (t) => console.log(`\n${C.BLUE}${'='.repeat(80)}${C.NC}\n${C.BLUE}  ${t}${C.NC}\n${C.BLUE}${'='.repeat(80)}${C.NC}\n`);
const ok = (t) => console.log(`${C.GREEN}OK ${t}${C.NC}`);
const fail = (t) => console.log(`${C.RED}ERR ${t}${C.NC}`);
const warn = (t) => console.log(`${C.YELLOW}WARN ${t}${C.NC}`);
const info = (t) => console.log(`${C.CYAN}INFO ${t}${C.NC}`);

let rl;
function ask(prompt) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${C.CYAN}${prompt}${C.NC}`, resolve));
}
function closeRl() { if (rl) { rl.close(); rl = null; } }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    userName: '',
    userPhone: '',
    companyName: '',
    location: '',
    businessName: '',
    deploymentPrefix: 'qsr-cn',
    nonInteractive: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case '--user-name':          out.userName = next; i++; break;
      case '--user-phone':         out.userPhone = next; i++; break;
      case '--company-name':       out.companyName = (next || '').trim(); i++; break;
      case '--location':           out.location = next; i++; break;
      case '--business-name':      out.businessName = next; i++; break;
      case '--deployment-prefix':  out.deploymentPrefix = next; i++; break;
      case '--non-interactive':    out.nonInteractive = true; break;
      case '--help':
      case '-h':
        console.log(`
Usage: node populate-data.js [OPTIONS]

Required:
  --user-name NAME          Display name for the seeded loyalty customer.
  --user-phone E164         Caller phone in E.164 (e.g. +12125550100).

Optional:
  --company-name NAME       Rebrand Geo Places results to this name
                            (e.g. "Example Cafe"). Otherwise uses the
                            raw business-name search term.
  --location STRING         City/zip/address for the location search.
                            Required in --non-interactive mode.
  --business-name STRING    Business search term (e.g. "burgers").
                            Required in --non-interactive mode.
  --deployment-prefix PFX   Pepper SSM path prefix (default: qsr-tel).
                            Resolves to /\${prefix}/customer-id-pepper.
  --non-interactive         Skip all interactive prompts.

Reads table names from cdk-outputs/cn-ddb.json (keyed on "DynamoDBStack").
`);
        process.exit(0);
    }
  }
  return out;
}

function loadTableNames(workspaceRoot) {
  const outputsPath = path.join(workspaceRoot, 'cdk-outputs', 'cn-ddb.json');
  if (!fs.existsSync(outputsPath)) {
    fail(`Deployment outputs not found at: ${outputsPath}`);
    info('Run the cn-ddb layer of scripts/deploy-all.sh first.');
    return null;
  }
  let outputs;
  try {
    outputs = JSON.parse(fs.readFileSync(outputsPath, 'utf-8'));
  } catch (e) {
    fail(`Failed to parse ${outputsPath}: ${e.message}`);
    return null;
  }
  const ddb = outputs.DynamoDBStack || {};
  const tables = {
    locations: ddb.LocationsTableName,
    customers: ddb.CustomersTableName,
    menu: ddb.MenuTableName,
    orders: ddb.OrdersTableName,
  };
  for (const [k, v] of Object.entries(tables)) {
    if (!v) {
      fail(`Missing ${k}TableName in ${outputsPath} under "DynamoDBStack".`);
      return null;
    }
  }
  return tables;
}

async function resolveLocation(geoClient, argsLocation, nonInteractive) {
  if (argsLocation) {
    const { isValid, coords } = validateCoordinates(argsLocation);
    if (isValid) {
      ok(`Coordinates: ${coords[0]}, ${coords[1]}`);
      return { lat: coords[0], lon: coords[1], address: `${coords[0]}, ${coords[1]}` };
    }
    info('Geocoding address...');
    const result = await geoClient.geocodeAddress(argsLocation);
    if (result) {
      ok(`Geocoded ${argsLocation} to ${result[0]}, ${result[1]}`);
      return { lat: result[0], lon: result[1], address: argsLocation };
    }
    fail(`Could not geocode "${argsLocation}".`);
    if (nonInteractive) {
      throw new Error(`Geocoding failed for "${argsLocation}" in --non-interactive mode.`);
    }
  }
  if (nonInteractive) {
    throw new Error('--non-interactive requires --location.');
  }
  info('Enter a city, zip, or full address.');
  while (true) {
    const input = (await ask('Location (city / zip / address / "lat,lon"): ')).trim();
    if (!input) { warn('Input cannot be empty'); continue; }
    const { isValid, coords } = validateCoordinates(input);
    if (isValid) return { lat: coords[0], lon: coords[1], address: `${coords[0]}, ${coords[1]}` };
    info('Geocoding address...');
    const result = await geoClient.geocodeAddress(input);
    if (result) return { lat: result[0], lon: result[1], address: input };
    fail('Could not geocode that. Try again or enter "lat, lon".');
  }
}

async function resolveBusinessName(argsBusiness, nonInteractive) {
  if (argsBusiness) {
    const { isValid, error } = validateBusinessName(argsBusiness);
    if (!isValid) throw new Error(`Invalid --business-name: ${error}`);
    return argsBusiness;
  }
  if (nonInteractive) throw new Error('--non-interactive requires --business-name.');
  info('Business to search for (e.g. pizza, burgers, coffee shop, tacos).');
  while (true) {
    const name = (await ask('Business name: ')).trim();
    const { isValid, error } = validateBusinessName(name);
    if (isValid) return name;
    fail(error);
  }
}

async function confirmYesNo(prompt, defaultYes = true) {
  while (true) {
    const choice = (await ask(`${prompt} (${defaultYes ? 'Y/n' : 'y/N'}): `)).trim().toLowerCase();
    if (choice === '' && defaultYes) return true;
    if (choice === '' && !defaultYes) return false;
    if (['yes', 'y'].includes(choice)) return true;
    if (['no', 'n'].includes(choice)) return false;
    warn('Please enter yes or no');
  }
}

function saveToJson(data, filename, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  ok(`Saved ${filepath}`);
}

async function ingestData(dynamodb, tableNames, data) {
  header('Ingesting Data into DynamoDB');
  info('Verifying tables exist...');
  for (const [kind, name] of Object.entries(tableNames)) {
    if (!(await dynamodb.verifyTableExists(name))) {
      fail(`Table not found (${kind}): ${name}`);
      throw new Error(`Table not found: ${name}`);
    }
  }
  ok('All tables verified');

  const datasets = [
    { label: `${data.locations.length} locations`, table: tableNames.locations, items: data.locations },
    { label: `${data.menu.length} menu items`, table: tableNames.menu, items: data.menu },
  ];
  // Customer + orders only when a loyalty customer was generated.
  if (data.customer) {
    datasets.push({ label: 'customer profile', table: tableNames.customers, items: [data.customer] });
  }
  if (Array.isArray(data.orders) && data.orders.length > 0) {
    datasets.push({ label: `${data.orders.length} orders`, table: tableNames.orders, items: data.orders });
  }

  for (const { label, table, items } of datasets) {
    info(`Writing ${label} -> ${table}...`);
    const result = await dynamodb.batchWriteItems(table, items);
    if (result.failed > 0) {
      fail(`Failed to write ${result.failed} items to ${table}`);
      result.errors.forEach((e) => fail(`  ${e.error_message}`));
      throw new Error(`Batch-write failures on ${table}`);
    }
    ok(`Wrote ${result.success} items to ${table}`);
  }
  ok('Data ingestion complete');
}

async function main() {
  const args = parseArgs();

  header('Telephony Voice Ordering Agent - Synthetic Data');

  // -- Decide whether we seed a loyalty customer -------------------------
  // --user-phone is the loyalty caller's identity. When it is omitted we
  // still seed Locations + Menu (so anonymous callers get a working demo)
  // but skip the Customer + Orders rows. A later run that supplies
  // --user-phone adds the loyalty data on top.
  const seedLoyalty = Boolean((args.userPhone || '').trim());

  let e164 = '';
  if (seedLoyalty) {
    // Validate the loyalty-customer args only when we are seeding loyalty.
    const { isValid: nameOk, error: nameErr } = validateUserName(args.userName);
    if (!nameOk) { fail(`--user-name: ${nameErr}`); return 2; }

    const { isValid: phoneOk, error: phoneErr, phone } = validateE164Phone(args.userPhone);
    if (!phoneOk) { fail(`--user-phone: ${phoneErr}`); return 2; }
    e164 = phone;
  } else {
    warn('No --user-phone provided: seeding Locations + Menu only (no loyalty customer).');
    info('Re-run later with --user-phone +1... to add the loyalty caller and order history.');
  }

  // -- Table names --------------------------------------------------------
  const workspaceRoot = path.resolve(__dirname, '..', '..');
  const tableNames = loadTableNames(workspaceRoot);
  if (!tableNames) return 1;
  ok(`Tables resolved from cdk-outputs/cn-ddb.json`);

  // -- Pepper + customerId (loyalty path only) ---------------------------
  let customerId = '';
  let email = '';
  if (seedLoyalty) {
    const pepperPath = `/${args.deploymentPrefix}/customer-id-pepper`;
    info(`Reading pepper from SSM: ${pepperPath}`);
    let pepper;
    try {
      pepper = await loadPepper(pepperPath);
    } catch (err) {
      fail(`Failed to read SSM pepper: ${err.message}`);
      info('Check that cn-gateway has been deployed (the runtime stack provisions this SecureString).');
      return 1;
    }
    ok(`Pepper loaded (length=${pepper.length} bytes)`);

    // -- Derive customer_id the way the agent will at call time -----------
    customerId = computeCustomerId(e164, pepper);
    email = `${slugifyName(args.userName)}@example.com`;
    ok(`customerId = ${customerId}`);
    info(`Synthetic email = ${email} (for Customers.email schema parity)`);
  }

  // -- User location + business search -----------------------------------
  header('Step 1: Location input');
  const geoClient = new GeoPlaces();
  const userLocation = await resolveLocation(geoClient, args.location, args.nonInteractive);

  header('Step 2: Business to search');
  const businessName = await resolveBusinessName(args.businessName, args.nonInteractive);

  header('Step 3: Searching Geo Places');
  info(`Searching "${businessName}" within 100 miles of (${userLocation.lat}, ${userLocation.lon})...`);
  const places = await geoClient.searchNearbyPlaces(userLocation.lat, userLocation.lon, businessName, 100, 50);
  if (!places.length) { fail('No locations found. Try a different business name or location.'); return 1; }
  ok(`Found ${places.length} locations`);

  // Display first 10 to keep the log readable
  places.slice(0, 10).forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.title} - ${p.address.label} (${geoClient.formatDistance(p.distance_meters)})`);
  });
  if (places.length > 10) console.log(`  ...and ${places.length - 10} more`);

  // Company-name rebrand (optional)
  let displayName = businessName;
  if (args.companyName && args.companyName.toLowerCase() !== businessName.toLowerCase()) {
    if (args.nonInteractive) {
      displayName = args.companyName;
      info(`Non-interactive: rebranding ${places.length} locations to "${args.companyName}"`);
    } else if (await confirmYesNo(`Rebrand locations to "${args.companyName}"?`, true)) {
      displayName = args.companyName;
      ok(`Rebranding to "${args.companyName}"`);
    }
  }

  // -- Customer home address --------------------------------------------
  // For telephony we always use the search location as the customer's home
  // address — there's no second prompt. (The reference project asks because
  // its web UI distinguishes "current location" from "home address"; on a
  // phone call that distinction is noise.)
  const homeLocation = userLocation;

  // -- Generate records -------------------------------------------------
  header('Step 4: Generating records');
  const locations = places.map((place) => {
    const locId = sanitizeLocationId(place.place_id, displayName);
    const locData = generateLocationData(place, displayName, locId);
    if (displayName !== businessName) {
      const city = locData.city || '';
      locData.name = city ? `${displayName} - ${city}` : displayName;
    }
    return locData;
  });
  ok(`Generated ${locations.length} Location records`);

  const menuItems = locations.flatMap((loc) => generateMenuItems(loc.locationId));
  ok(`Generated ${menuItems.length} Menu items (${Math.floor(menuItems.length / locations.length)} per location)`);

  // Loyalty customer + order history are only generated when a phone was
  // supplied (seedLoyalty). Otherwise we ship Locations + Menu alone so
  // anonymous callers get a working demo.
  let customerData = null;
  let orders = [];
  if (seedLoyalty) {
    customerData = generateCustomerData(
      customerId,
      args.userName,
      e164,
      email,
      homeLocation.address,
      [homeLocation.lat, homeLocation.lon],
    );
    ok(`Generated Customer ${args.userName} (${customerId}, phone ${e164})`);

    const nearbyLocations = locations.filter((l) => (l.distance_meters || 0) < 16093); // 10 miles
    const ordersLocations = nearbyLocations.length ? nearbyLocations : locations.slice(0, 3);
    orders = generateOrders(customerId, ordersLocations, 5);
    ok(`Generated ${orders.length} sample Orders`);
  } else {
    info('Skipping Customer + Orders generation (no --user-phone).');
  }

  // -- Save local JSON ---------------------------------------------------
  header('Step 5: Local JSON snapshot');
  const outputDir = path.join(__dirname, 'output');
  saveToJson(locations, 'locations.json', outputDir);
  saveToJson(menuItems, 'menu.json', outputDir);
  if (seedLoyalty) {
    saveToJson([customerData], 'customer.json', outputDir);
    saveToJson(orders, 'orders.json', outputDir);
  }

  // -- Ingest ------------------------------------------------------------
  if (!args.nonInteractive) {
    if (!(await confirmYesNo('Write to DynamoDB now?', true))) {
      warn('Ingestion cancelled; JSON files are in backend/synthetic-data/output/');
      closeRl();
      return 0;
    }
  }
  const dynamodb = new DynamoDB();
  await ingestData(dynamodb, tableNames, { locations, customer: customerData, menu: menuItems, orders });

  header('Complete');
  if (seedLoyalty) {
    ok(`Seeded ${locations.length} locations, 1 customer, ${menuItems.length} menu items, ${orders.length} orders`);
    info(`Test caller identity: ${args.userName} <${email}> ${e164}`);
    info(`Customers PK: CUSTOMER#${customerId}`);
    info('Dial the telephony agent from this number to test the loyalty greeting path.');
  } else {
    ok(`Seeded ${locations.length} locations, ${menuItems.length} menu items (no loyalty customer)`);
    info('Anonymous callers can order end-to-end. To add a loyalty caller later, re-run:');
    info('  ./scripts/deploy-all.sh --only cn-synthetic-data --user-name "Jane Doe" --user-phone +1...');
  }

  closeRl();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    fail(`Unexpected error: ${err.message}`);
    console.error(err);
    closeRl();
    process.exit(1);
  });
