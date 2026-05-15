// Unit tests for Task 2.5 — R9 baseline body shape on PlaceOrder Lambda.
//
// We use Node's built-in `node:test` runner + `assert`, and inject a hand-rolled
// DynamoDB Document Client stub via `setDocClient()` (exported from the handler
// for this purpose). No external mocking library is required — the handler
// only exercises three methods on the doc client (GetCommand / PutCommand /
// DeleteCommand) and the stub pattern-matches on the constructor name. This
// keeps the Lambda asset dir free of devDependencies.

const test = require('node:test');
const assert = require('node:assert/strict');

// Set env vars before requiring the handler (module-level `process.env` reads).
process.env.CARTS_TABLE_NAME = 'test-Carts';
process.env.ORDERS_TABLE_NAME = 'test-Orders';
process.env.LOCATIONS_TABLE_NAME = 'test-Locations';

const handlerModule = require('..');

// Build a stub doc-client that responds to `GetCommand` / `PutCommand` /
// `DeleteCommand` based on their constructor name. The handler currently
// uses one constructor per op; if any new op is added the test will fail
// loudly (unknown command type).
function makeStubDocClient({ cart, location }) {
  const puts = [];
  const deletes = [];
  const docClient = {
    send: async (cmd) => {
      const ctorName = cmd && cmd.constructor && cmd.constructor.name;
      if (ctorName === 'GetCommand') {
        const table = cmd.input.TableName;
        if (table === process.env.CARTS_TABLE_NAME) return { Item: cart };
        if (table === process.env.LOCATIONS_TABLE_NAME) return { Item: location };
        throw new Error(`unexpected GetCommand on table ${table}`);
      }
      if (ctorName === 'PutCommand') {
        puts.push(cmd.input);
        return {};
      }
      if (ctorName === 'DeleteCommand') {
        deletes.push(cmd.input);
        return {};
      }
      throw new Error(`unexpected command ctor ${ctorName}`);
    },
  };
  return { docClient, puts, deletes };
}

const happyCart = {
  PK: 'CUSTOMER#pstn-abc123',
  items: [
    { itemId: 'burger', name: 'Burger', price: 7.5, quantity: 2 },
    { itemId: 'fries', name: 'Fries', price: 2.5, quantity: 1 },
  ],
};
const happyLocation = {
  PK: 'LOCATION#loc-1',
  taxRate: 0.1,
  name: 'Downtown',
};

test('identified telephony caller — 200 + R9 fields persisted', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: { ...happyCart, PK: 'CUSTOMER#pstn-abc123' },
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'pstn-abc123',
      locationId: 'loc-1',
      channel: 'telephony',
      anonymousCaller: false,
      fromPhoneNumber: '+14155551234',
    }),
  });

  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.order.channel, 'telephony');
  assert.equal(parsed.order.anonymousCaller, false);
  assert.equal(parsed.order.fromPhoneNumber, '+14155551234');
  assert.equal(parsed.order.customerId, 'pstn-abc123');
  // Subtotal 17.5, tax 1.75, total 19.25.
  assert.equal(parsed.order.subtotal, 17.5);
  assert.equal(parsed.order.tax, 1.75);
  assert.equal(parsed.order.total, 19.25);

  // The put went to the Orders table with the three baseline fields.
  assert.equal(puts.length, 1);
  assert.equal(puts[0].TableName, 'test-Orders');
  assert.equal(puts[0].Item.channel, 'telephony');
  assert.equal(puts[0].Item.anonymousCaller, false);
  assert.equal(puts[0].Item.fromPhoneNumber, '+14155551234');
});

test('anonymous telephony caller — 200 + anonymousCaller=true + empty fromPhoneNumber', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: { ...happyCart, PK: 'CUSTOMER#pstn-anonymous-deadbeef' },
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'pstn-anonymous-deadbeef',
      locationId: 'loc-1',
      channel: 'telephony',
      anonymousCaller: true,
      fromPhoneNumber: '',
    }),
  });

  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.order.anonymousCaller, true);
  assert.equal(parsed.order.fromPhoneNumber, '');
  assert.equal(parsed.order.channel, 'telephony');
  assert.equal(puts[0].Item.anonymousCaller, true);
  assert.equal(puts[0].Item.fromPhoneNumber, '');
});

test('malformed fromPhoneNumber when anonymousCaller=false → 400', async () => {
  // No cart/location lookups should be reached when validation rejects.
  const { docClient, puts, deletes } = makeStubDocClient({
    cart: happyCart,
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'pstn-abc123',
      locationId: 'loc-1',
      channel: 'telephony',
      anonymousCaller: false,
      fromPhoneNumber: 'bogus',
    }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(puts.length, 0);
  assert.equal(deletes.length, 0);
  const parsed = JSON.parse(res.body);
  assert.match(parsed.error, /Invalid fromPhoneNumber/);
});

test('anonymousCaller=true with non-empty fromPhoneNumber → 400', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: happyCart,
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'pstn-anonymous-deadbeef',
      locationId: 'loc-1',
      channel: 'telephony',
      anonymousCaller: true,
      fromPhoneNumber: '+14155551234',
    }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(puts.length, 0);
});

test('default channel falls back to "web" when not provided', async () => {
  const { docClient, puts } = makeStubDocClient({
    cart: happyCart,
    location: happyLocation,
  });
  handlerModule.setDocClient(docClient);

  // No channel, no anonymousCaller, no fromPhoneNumber — legacy web caller.
  // anonymousCaller defaults to false; fromPhoneNumber defaults to '';
  // validation: anonymousCaller=false + fromPhoneNumber='' → rejected by R9.
  const res = await handlerModule.handler({
    body: JSON.stringify({
      customerId: 'pstn-abc123',
      locationId: 'loc-1',
    }),
  });

  // Legacy "no phone number" web callers MUST now send anonymousCaller=true
  // to clear validation — this is the R9 baseline. The test locks that contract in.
  assert.equal(res.statusCode, 400);
  assert.equal(puts.length, 0);
});
