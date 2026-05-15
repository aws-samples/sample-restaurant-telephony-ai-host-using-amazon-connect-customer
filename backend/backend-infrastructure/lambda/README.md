# Lambda Functions

This directory contains Node.js TypeScript Lambda functions that implement the business logic for the QSR ordering system.

## Technology Stack

- **Node.js 20.x** runtime
- **TypeScript** for type safety
- **AWS SDK v3** for DynamoDB and Amazon Location Service
- **Jest** for unit testing
- **fast-check** for property-based testing

## Expected Structure

```
backend/lambda/
├── get-customer-profile/
│   ├── index.ts                    # Lambda handler
│   ├── types.ts                    # TypeScript interfaces
│   ├── tests/
│   │   ├── unit.test.ts            # Unit tests
│   │   └── property.test.ts        # Property-based tests
│   ├── package.json
│   └── tsconfig.json
├── get-previous-orders/
│   ├── index.ts
│   ├── types.ts
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
├── get-menu/
├── add-to-cart/
├── place-order/
├── get-nearest-locations/
├── find-location-along-route/
├── geocode-address/
├── shared/                         # Shared utilities
│   ├── dynamodb-client.ts          # DynamoDB Document Client
│   ├── location-client.ts          # Amazon Location Service client
│   ├── types.ts                    # Common types
│   └── utils.ts                    # Helper functions
└── README.md                       # This file
```

## Lambda Functions

### 1. GetCustomerProfile
**Purpose**: Retrieve customer profile from DynamoDB

**Input**:
```typescript
{
  customerId: string
}
```

**Output**:
```typescript
{
  customerId: string,
  name: string,
  loyaltyTier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum',
  loyaltyPoints: number,
  preferredLocationId?: string
}
```

**DynamoDB Access**: Query Customers table by PK

---

### 2. GetPreviousOrders
**Purpose**: Retrieve customer's last 5 orders

**Input**:
```typescript
{
  customerId: string
}
```

**Output**:
```typescript
{
  orders: Array<{
    orderId: string,
    locationId: string,
    locationName: string,
    items: OrderItem[],
    total: number,
    createdAt: string
  }>
}
```

**DynamoDB Access**: Query Orders table by PK, sort by SK descending, limit 5

---

### 3. GetMenu
**Purpose**: Get location-specific menu items

**Input**:
```typescript
{
  locationId: string
}
```

**Output**:
```typescript
{
  items: Array<{
    itemId: string,
    name: string,
    description: string,
    price: number,
    category: string[],
    isAvailable: boolean,
    availableCustomizations: Customization[]
  }>
}
```

**DynamoDB Access**: Query Menu table with `begins_with(PK, "LOCATION#{locationId}#")`

---

### 4. AddToCart
**Purpose**: Add item to cart with availability verification

**Input**:
```typescript
{
  sessionId: string,
  locationId: string,
  itemId: string,
  quantity: number,
  customizations: Customization[]
}
```

**Output**:
```typescript
{
  success: boolean,
  cart: Cart,
  error?: string
}
```

**DynamoDB Access**: 
1. GetItem from Menu table to verify availability
2. UpdateItem in Carts table

---

### 5. PlaceOrder
**Purpose**: Create order from cart

**Input**:
```typescript
{
  sessionId: string,
  customerId: string,
  locationId: string
}
```

**Output**:
```typescript
{
  orderId: string,
  total: number,
  estimatedReadyTime: string
}
```

**DynamoDB Access**:
1. GetItem from Carts table
2. PutItem to Orders table
3. DeleteItem from Carts table

---

### 6. GetNearestLocations
**Purpose**: Find nearby restaurants using Amazon Location Service

**Input**:
```typescript
{
  latitude: number,
  longitude: number
}
```

**Output**:
```typescript
{
  locations: Array<{
    locationId: string,
    name: string,
    address: string,
    distance: number,
    coordinates: { lat: number, lng: number }
  }>
}
```

**AWS Services**: Amazon Location Service SearchNearby API

---

### 7. FindLocationAlongRoute
**Purpose**: Find restaurants along route with minimal detour

**Input**:
```typescript
{
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
}
```

**Output**:
```typescript
{
  locations: Array<{
    locationId: string,
    name: string,
    detourMinutes: number,
    coordinates: { lat: number, lng: number }
  }>
}
```

**AWS Services**: Amazon Location Service CalculateRoutes API

---

### 8. GeocodeAddress
**Purpose**: Convert address to coordinates

**Input**:
```typescript
{
  address: string
}
```

**Output**:
```typescript
{
  latitude: number,
  longitude: number,
  formattedAddress: string
}
```

**AWS Services**: Amazon Location Service SearchPlaceIndexForText API

---

## AgentCore Action Group Contract

All Lambda functions follow the AgentCore action group contract:

**Input Event**:
```typescript
interface AgentCoreEvent {
  messageVersion: string;
  agent: { name: string; id: string; alias: string; version: string };
  inputText: string;
  sessionId: string;
  actionGroup: string;
  function: string;
  parameters: Array<{ name: string; type: string; value: string }>;
  sessionAttributes: Record<string, string>;
  promptSessionAttributes: Record<string, string>;
}
```

**Output Response**:
```typescript
interface AgentCoreResponse {
  messageVersion: string;
  response: {
    actionGroup: string;
    function: string;
    functionResponse: {
      responseState?: 'FAILURE' | 'REPROMPT';
      responseBody: { TEXT: { body: string } };
    };
  };
  sessionAttributes: Record<string, string>;
  promptSessionAttributes: Record<string, string>;
}
```

## Development

```bash
# Install dependencies for all functions
npm install

# Build TypeScript
npm run build

# Run unit tests
npm test

# Run property-based tests
npm run test:property

# Run specific function tests
cd get-customer-profile && npm test

# Package for deployment
npm run package
```

## Testing Strategy

### Unit Tests
- Test specific examples and edge cases
- Mock DynamoDB and Amazon Location Service
- Verify response structure
- Test error handling

### Property-Based Tests
- Test universal properties across all inputs
- Use fast-check for random input generation
- Verify correctness properties from design document
- Example: "For any location ID, GetMenu returns only available items"

## Error Handling

All Lambda functions implement:
- Structured error logging to CloudWatch
- Graceful error responses to AgentCore
- DynamoDB retry logic with exponential backoff
- Input validation
- Timeout handling

## IAM Permissions

Each Lambda function has least-privilege IAM roles:
- DynamoDB: GetItem, Query, PutItem, UpdateItem, DeleteItem (table-specific)
- Amazon Location Service: SearchPlaceIndexForText, SearchNearby, CalculateRoutes
- CloudWatch Logs: CreateLogGroup, CreateLogStream, PutLogEvents

## Deployment

Lambda functions are deployed via CDK LambdaStack:
- Bundled with esbuild for optimal size
- Environment variables for table names
- VPC configuration (if needed)
- Reserved concurrency (if needed)
- CloudWatch alarms for errors and duration
