/**
 * Bitget L1A Q0 offline read qualification.
 *
 * Offline only: the qualification runs the real transport and foundation against an injected fake
 * fetch. No real credential, no real network, no trading authority.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BITGET_L1A_Q0_SCHEMA_VERSION,
  BITGET_Q0_MAX_ACCOUNT_SNAPSHOT_GETS,
  BITGET_Q0_MAX_INSTRUMENT_SNAPSHOT_GETS,
  bitgetOfflineQualificationFailedReasons,
  runBitgetOfflineReadQualification,
} from '../../src/runtime/bitget/BitgetOfflineReadQualification';
import type { BitgetReadIdentity } from '../../src/runtime/bitget/BitgetAuthenticatedReadClient';

const FIXTURE_BITGET_API_KEY = 'FIXTURE_BITGET_API_KEY';
const FIXTURE_BITGET_SECRET = 'FIXTURE_BITGET_SECRET';
const FIXTURE_BITGET_PASSPHRASE = 'FIXTURE_BITGET_PASSPHRASE';
const BASE_MS = 1_799_000_000_000;

const identity: BitgetReadIdentity = Object.freeze({ exchange: 'bitget', accountId: 'acct-1' });
const credential = Object.freeze({
  apiKey: FIXTURE_BITGET_API_KEY,
  secretKey: FIXTURE_BITGET_SECRET,
  passphrase: FIXTURE_BITGET_PASSPHRASE,
});

const run = (overrides: Record<string, unknown> = {}) => runBitgetOfflineReadQualification({
  runId: 'bitget-l1a-q0',
  identity,
  credential,
  now: () => BASE_MS,
  ...overrides,
});

describe('Bitget L1A Q0 offline qualification', () => {
  it('1. every declared check passes on the valid fixture set', async () => {
    const receipt = await run();
    const failed = Object.entries(receipt.CHECKS).filter(([, ok]) => ok !== true).map(([name]) => name);
    assert.deepEqual(failed, [], `failing checks: ${failed.join(', ')}`);
    assert.equal(Object.keys(receipt.CHECKS).length >= 36, true);
  });

  it('2. the receipt is an offline simulation that claims no real read or connectivity', async () => {
    const receipt = await run();
    assert.equal(receipt.SCHEMA_VERSION, BITGET_L1A_Q0_SCHEMA_VERSION);
    assert.equal(receipt.MODE, 'OFFLINE_SIMULATION');
    assert.equal(receipt.TRANSPORT_PROVENANCE, false);
    assert.equal(receipt.REAL_CREDENTIAL_USED, false);
    assert.equal(receipt.FIXTURE_CREDENTIAL_USED, true);
    assert.equal(receipt.REAL_NETWORK_USED, false);
    assert.equal(receipt.PRODUCTION_CONNECTIVITY_VERIFIED, false);
    assert.equal(receipt.REAL_READ_VERIFIED, false);
    assert.equal(receipt.EXECUTION_AUTHORITY, false);
    assert.equal(receipt.LIVE_READY, false);
    assert.equal(receipt.SOURCE, 'bitget-usdm-read');
  });

  it('3. normalized aggregates match the declared fixtures', async () => {
    const receipt = await run();
    assert.equal(receipt.ACCOUNT_TRUTH_AVAILABLE, true);
    assert.equal(receipt.INSTRUMENT_FACTS_AVAILABLE, true);
    assert.equal(receipt.ACCOUNT_STATE, 'OPEN');
    assert.equal(receipt.BALANCE_COUNT, 1);
    assert.equal(receipt.POSITION_COUNT, 1);
    assert.equal(receipt.OPEN_ORDER_COUNT, 1);
    assert.equal(receipt.RECENT_FILL_COUNT, 1);
    assert.equal(receipt.FEE_DETAIL_ENTRIES, 1);
    assert.equal(receipt.ACCOUNT_FRESHNESS, 'FRESH');
    assert.equal(receipt.MARK_PRICE_FRESHNESS, 'FRESH');
    assert.equal(receipt.MIN_QTY, 0.001);
    assert.equal(receipt.QUANTITY_MULTIPLE, 0.01);
    assert.equal(receipt.QUANTITY_MULTIPLE_BASIS, 'SIZE_MULTIPLIER');
    assert.equal(receipt.QUANTITY_PRECISION, 3);
    assert.equal(receipt.QUANTITY_PRECISION_BASIS, 'VOLUME_PLACE');
    assert.notEqual(receipt.QUANTITY_MULTIPLE, 0.001, 'precision unit must not be the multiple');
    assert.notEqual(receipt.QUANTITY_MULTIPLE, 1 / 10 ** (receipt.QUANTITY_PRECISION ?? 0));
    assert.equal(receipt.PRICE_STEP, 0.01);
    assert.equal(receipt.PRICE_STEP_BASIS, 'PRICE_END_STEP_AT_PRICE_PLACE');
    assert.equal(receipt.PRICE_PRECISION, 2);
  });

  it('4. request budgets are declared and respected', async () => {
    const receipt = await run();
    assert.equal(receipt.ACCOUNT_SNAPSHOT_GET_BUDGET, BITGET_Q0_MAX_ACCOUNT_SNAPSHOT_GETS);
    assert.equal(receipt.INSTRUMENT_SNAPSHOT_GET_BUDGET, BITGET_Q0_MAX_INSTRUMENT_SNAPSHOT_GETS);
    assert.equal(receipt.ACCOUNT_SNAPSHOT_GETS, 5);
    assert.equal(receipt.INSTRUMENT_SNAPSHOT_GETS, 3);
    assert.ok(receipt.ACCOUNT_SNAPSHOT_GETS <= receipt.ACCOUNT_SNAPSHOT_GET_BUDGET);
    assert.ok(receipt.INSTRUMENT_SNAPSHOT_GETS <= receipt.INSTRUMENT_SNAPSHOT_GET_BUDGET);
  });

  it('5. entry readiness is safe on the valid fixture and never gates close/reduce', async () => {
    const receipt = await run();
    assert.equal(receipt.ENTRY_READINESS?.safeToOpen, true);
    assert.deepEqual(receipt.ENTRY_READINESS?.blockers, []);
    assert.equal(receipt.ENTRY_READINESS?.closeOrReduceBlockedByEntryFreshness, false);
  });

  it('6. every fail-closed case is proven with its own sanitized reason', async () => {
    const receipt = await run();
    const cases = receipt.FAIL_CLOSED_CASES;
    assert.equal(cases.MISSING_CREDENTIAL, 'BITGET_READ_CREDENTIALS_UNAVAILABLE');
    assert.equal(cases.MALFORMED_POSITIONS, 'POSITION_TRUTH_MALFORMED');
    assert.equal(cases.MALFORMED_BALANCE, 'ACCOUNT_TRUTH_MALFORMED');
    assert.equal(cases.MALFORMED_FILLS, 'FILLS_MALFORMED');
    assert.equal(cases.MALFORMED_OPEN_ORDERS, 'OPEN_ORDERS_MALFORMED');
    assert.equal(cases.MISSING_SYMBOL, 'MARKET_RULES_UNKNOWN');
    assert.equal(cases.MAINTENANCE_CONTRACT, 'CONTRACT_NOT_OPENABLE');
    assert.equal(cases.STALE_MARK_PRICE, 'MARK_PRICE_STALE');
    assert.equal(cases.UNKNOWN_MARK_PRICE_TIMESTAMP, 'MARK_PRICE_UNKNOWN');
    assert.equal(cases.UNDERIVABLE_CONTRACT_RULES, 'MARKET_RULES_UNKNOWN');
    assert.equal(cases.MISSING_SIZE_MULTIPLIER, 'MARKET_RULES_UNKNOWN');
    assert.equal(cases.MISSING_VOLUME_PLACE, 'MARKET_RULES_UNKNOWN');
    assert.equal(cases.ZERO_SIZE_MULTIPLIER, 'MARKET_RULES_UNKNOWN');
    assert.equal(cases.CLOCK_SKEW, 'BITGET_CLOCK_SKEW_INVALID');
    assert.equal(cases.NETWORK_FAILURE, 'BITGET_READ_TRANSPORT_FAILED');
    assert.equal(cases.EXCHANGE_REJECTION, 'BITGET_READ_API_REJECTED');
    const reasons = bitgetOfflineQualificationFailedReasons(receipt);
    assert.equal(reasons.length >= 16, true);
    const serialized = JSON.stringify(cases);
    for (const fixture of [FIXTURE_BITGET_API_KEY, FIXTURE_BITGET_SECRET, FIXTURE_BITGET_PASSPHRASE]) {
      assert.equal(serialized.includes(fixture), false);
    }
  });

  it('6b. the distinguishing fixtures prove precision is not the quantity multiple', async () => {
    const receipt = await run();
    assert.equal(receipt.CHECKS.QUANTITY_MULTIPLE_IS_SIZE_MULTIPLIER, true);
    assert.equal(receipt.CHECKS.QUANTITY_PRECISION_IS_VOLUME_PLACE, true);
    assert.equal(receipt.CHECKS.QUANTITY_MULTIPLE_IS_NOT_PRECISION_UNIT, true);
    assert.equal(receipt.CHECKS.PRICE_STEP_IS_END_STEP_AT_PRICE_PLACE, true);
    assert.equal(receipt.CHECKS.DISTINGUISHING_PRICE_STEP_DERIVED, true);
    assert.equal(receipt.CHECKS.MISSING_SIZE_MULTIPLIER_FAILS_CLOSED, true);
    assert.equal(receipt.CHECKS.MISSING_VOLUME_PLACE_FAILS_CLOSED, true);
    assert.equal(receipt.CHECKS.ZERO_SIZE_MULTIPLIER_FAILS_CLOSED, true);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes('VOLUME_PLACE_PRECISION'), false);
    assert.equal(serialized.includes('quantityStep'), false);
  });

  it('7. the secret and signature leak scan is clean', async () => {
    const receipt = await run();
    assert.deepEqual(receipt.SECRET_LEAK_SCAN, {
      API_KEY_IN_RECEIPT: false,
      SECRET_IN_RECEIPT: false,
      PASSPHRASE_IN_RECEIPT: false,
      SIGNATURE_IN_RECEIPT: false,
      ACCESS_SIGN_IN_CAPTURED_URL: false,
    });
    const serialized = JSON.stringify(receipt);
    for (const fixture of [FIXTURE_BITGET_API_KEY, FIXTURE_BITGET_SECRET, FIXTURE_BITGET_PASSPHRASE]) {
      assert.equal(serialized.includes(fixture), false);
    }
  });

  it('8. the qualification is deterministic for identical inputs', async () => {
    const first = await run();
    const second = await run();
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('9. the qualification fails closed rather than claiming success when fixtures are broken', async () => {
    const broken = await run({ payloads: { positions: { bad: true }, contracts: [] } });
    assert.equal(broken.CHECKS.ACCOUNT_TRUTH_NORMALIZED, false);
    assert.equal(broken.CHECKS.ENTRY_READINESS_SAFE_ON_VALID_FIXTURE, false);
    assert.equal(broken.ACCOUNT_STATE, null);
    assert.equal(broken.ACCOUNT_TRUTH_AVAILABLE, false);
    assert.equal(broken.REAL_READ_VERIFIED, false);
    assert.equal(broken.PRODUCTION_CONNECTIVITY_VERIFIED, false);
  });
});
