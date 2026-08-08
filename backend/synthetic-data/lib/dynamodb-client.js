/**
 * DynamoDB client for data ingestion.
 *
 * Batch-writes seed rows into the ordering tables.
 * Telephony feature writes to the same PK/SK shape (Customers: PK=CUSTOMER#<id> SK=PROFILE;
 * Locations: PK=LOCATION#<id>; Menu: PK=LOCATION#<id>#ITEM#<id>; Orders: PK=CUSTOMER#<id>
 * SK=ORDER#<orderId>#<ts>).
 */
const { DynamoDBClient, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

class DynamoDB {
  constructor(region = 'us-east-1') {
    const client = new DynamoDBClient({ region });
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.raw = client;
  }

  async batchWriteItems(tableName, items) {
    if (!items.length) return { success: 0, failed: 0, errors: [] };

    let success = 0;
    let failed = 0;
    const errors = [];
    const BATCH_SIZE = 25;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const requestItems = { [tableName]: batch.map((item) => ({ PutRequest: { Item: item } })) };

      try {
        let unprocessed = requestItems;
        let retries = 0;

        while (Object.keys(unprocessed).length > 0 && retries < 3) {
          const result = await this.doc.send(new BatchWriteCommand({ RequestItems: unprocessed }));
          const remaining = result.UnprocessedItems || {};

          const written = batch.length - (remaining[tableName] || []).length;
          success += written;

          if (Object.keys(remaining).length > 0) {
            unprocessed = remaining;
            retries++;
            await new Promise((r) => setTimeout(r, 100 * 2 ** retries));
          } else {
            break;
          }
        }

        if (Object.keys(unprocessed).length > 0 && retries >= 3) {
          const leftover = (unprocessed[tableName] || []).length;
          failed += leftover;
          errors.push({
            batch_start: i,
            error_code: 'UnprocessedItems',
            error_message: `${leftover} items unprocessed after retries`,
          });
        }
      } catch (err) {
        failed += batch.length;
        errors.push({
          batch_start: i,
          batch_size: batch.length,
          error_code: err.name || 'UnexpectedError',
          error_message: err.message,
        });
      }
    }

    return { success, failed, errors };
  }

  async verifyTableExists(tableName) {
    try {
      await this.raw.send(new DescribeTableCommand({ TableName: tableName }));
      return true;
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') return false;
      throw err;
    }
  }

  async scanAndDeleteAll(tableName) {
    const desc = await this.raw.send(new DescribeTableCommand({ TableName: tableName }));
    const keyNames = desc.Table.KeySchema.map((k) => k.AttributeName);

    let deleted = 0;
    let errorCount = 0;
    let lastKey;

    do {
      const scanResult = await this.doc.send(
        new ScanCommand({
          TableName: tableName,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );

      const items = scanResult.Items || [];
      if (!items.length) break;

      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const deleteRequests = batch.map((item) => {
          const key = {};
          for (const k of keyNames) if (item[k] !== undefined) key[k] = item[k];
          return { DeleteRequest: { Key: key } };
        });

        try {
          await this.doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: deleteRequests } }));
          deleted += batch.length;
        } catch (err) {
          console.error(`❌ Failed to delete batch: ${err.message}`);
          errorCount += batch.length;
        }
      }

      lastKey = scanResult.LastEvaluatedKey;
    } while (lastKey);

    return { deleted, errors: errorCount };
  }
}

module.exports = { DynamoDB };
