#!/usr/bin/env node
/**
 * Cleanup synthetic data from DynamoDB.
 *
 * Table names come from cdk-outputs/cn-ddb.json, keyed on the logical stack id
 * "DynamoDBStack".
 *
 * Usage:
 *   node cleanup-data.js              # interactive confirm
 *   node cleanup-data.js --force      # non-interactive (deploy-all.sh path)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { DynamoDB } = require('./lib/dynamodb-client');

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

function loadTableNames(workspaceRoot) {
  const outputsPath = path.join(workspaceRoot, 'cdk-outputs', 'cn-ddb.json');
  if (!fs.existsSync(outputsPath)) { fail(`Deployment outputs not found at: ${outputsPath}`); return null; }
  let outputs;
  try { outputs = JSON.parse(fs.readFileSync(outputsPath, 'utf-8')); } catch (e) { fail(`Failed to parse: ${e.message}`); return null; }
  const ddb = outputs.DynamoDBStack || {};
  const tables = {
    locations: ddb.LocationsTableName,
    customers: ddb.CustomersTableName,
    menu: ddb.MenuTableName,
    orders: ddb.OrdersTableName,
  };
  for (const [k, v] of Object.entries(tables)) {
    if (!v) { fail(`Missing ${k}TableName in cn-ddb.json`); return null; }
  }
  return tables;
}

async function main() {
  const force = process.argv.includes('--force');

  header('Telephony Synthetic Data - Cleanup');

  const workspaceRoot = path.resolve(__dirname, '..', '..');
  const tableNames = loadTableNames(workspaceRoot);
  if (!tableNames) return 1;

  if (!force) {
    warn('This will DELETE ALL DATA from the following tables:');
    for (const name of Object.values(tableNames)) warn(`  - ${name}`);
    warn('This operation CANNOT be undone.');
    const choice = (await ask('Proceed? (yes/no): ')).trim().toLowerCase();
    if (!['yes', 'y'].includes(choice)) { warn('Cleanup cancelled'); closeRl(); return 0; }
  }

  header('Deleting');
  const dynamodb = new DynamoDB();
  let totalDeleted = 0;
  let totalErrors = 0;

  for (const [, name] of Object.entries(tableNames)) {
    info(`Scanning + deleting ${name}...`);
    const result = await dynamodb.scanAndDeleteAll(name);
    if (result.errors > 0) fail(`${name}: deleted ${result.deleted} with ${result.errors} errors`);
    else ok(`${name}: deleted ${result.deleted} items`);
    totalDeleted += result.deleted;
    totalErrors += result.errors;
  }

  header('Cleanup complete');
  if (totalErrors > 0) warn(`Deleted ${totalDeleted} with ${totalErrors} errors`);
  else ok(`Deleted ${totalDeleted} items across ${Object.keys(tableNames).length} tables`);

  closeRl();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { fail(`Unexpected error: ${err.message}`); console.error(err); closeRl(); process.exit(1); });
