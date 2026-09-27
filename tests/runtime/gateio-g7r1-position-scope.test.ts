/** Offline account-wide positions payloads through the real authenticated read foundation. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGateIoAuthenticatedReadFoundation, normalizeGateIoPosition } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { GATEIO_READ_ENDPOINTS as E, type GateIoReadEndpoint } from '../../src/runtime/gateio/GateIoReadContracts';

const NOW = 1_800_000_000_000;
function position(contract = 'ETH_USDT', mode = 'single', size = '0', value = '0') {
  const exposed = Number(size) !== 0 || Number(value) !== 0;
  return { contract, mode, size, value, entry_price: exposed ? '2000' : null,
    mark_price: exposed ? '2001' : null, update_time: String(NOW / 1000) };
}
const foreign = Object.freeze(['BTC_USDT', 'SOL_USDT', 'XRP_USDT', 'DOGE_USDT', 'BNB_USDT']
  .map((contract, index) => Object.freeze(position(contract, 'single', String(index + 1), '2000'))));

async function readPositions(payload: unknown, inDualMode: boolean | null = false) {
  const calls: GateIoReadEndpoint[] = [];
  const foundation = createGateIoAuthenticatedReadFoundation({
    identity: { exchange: 'gateio', accountId: 'offline-g7r1', settle: 'USDT' },
    credential: { apiKey: 'OFFLINE_G7R1_KEY', secretKey: 'OFFLINE_G7R1_SECRET' },
    now: () => NOW,
    transport: { async get(request) {
      calls.push(request.endpoint);
      switch (request.endpoint) {
        case E.SERVER_TIME: return { server_time: NOW };
        case E.ACCOUNTS: return { currency: 'USDT', total: '1000', available: '900',
          in_dual_mode: inDualMode, margin_mode: 0 };
        case E.POSITIONS: return payload;
        case E.OPEN_ORDERS: case E.MY_TRADES: return [];
        default: assert.fail('unexpected read endpoint');
      }
    } },
  });
  return { result: await foundation.accountTruth(), calls };
}

async function malformed(payload: unknown, dual: boolean | null = false) {
  const { result, calls } = await readPositions(payload, dual);
  assert.equal(result.availability, 'UNKNOWN');
  assert.equal(result.reason, 'POSITION_TRUTH_MALFORMED');
  assert.equal(result.value, null);
  assert.notEqual(result.value?.accountState, 'FLAT');
  assert.deepEqual(calls, [E.SERVER_TIME, E.ACCOUNTS, E.POSITIONS]);
}

describe('Gate G7R1 positions scope before strict normalization', () => {
  it('A: six-row SINGLE selects exactly one ETH row and preserves strict canonical facts', async () => {
    const eth = position('ETH_USDT', 'single', '1', '2000');
    const payload = [foreign[0], foreign[1], eth, ...foreign.slice(2)];
    assert.equal(payload.length, 6);
    const { result, calls } = await readPositions(payload);
    assert.equal(result.availability, 'AVAILABLE');
    assert.deepEqual(result.value?.positions, [normalizeGateIoPosition(eth)]);
    assert.equal(result.value?.accountState, 'OPEN');
    assert.equal(result.value?.accountStateBasis, 'FACTUAL_POSITIONS_RESPONSE');
    assert.equal(Object.isFrozen(result.value?.positions), true);
    assert.deepEqual(calls, [E.SERVER_TIME, E.ACCOUNTS, E.POSITIONS, E.OPEN_ORDERS, E.MY_TRADES]);
  });
  it('B: six-row DUAL selects only the two distinct ETH legs', async () => {
    const long = position('ETH_USDT', 'dual_long', '1', '2000');
    const short = position('ETH_USDT', 'dual_short', '-1', '-2000');
    const payload = [foreign[0], short, foreign[1], long, foreign[2], foreign[3]];
    assert.equal(payload.length, 6);
    const { result } = await readPositions(payload, true);
    assert.equal(result.availability, 'AVAILABLE');
    assert.deepEqual(result.value?.positions, [normalizeGateIoPosition(short), normalizeGateIoPosition(long)]);
    assert.equal(result.value?.accountState, 'OPEN');
  });
  for (const dual of [false, true]) it(`C: missing ETH in ${dual ? 'dual' : 'single'} is never FLAT`, async () => {
    await malformed([...foreign], dual);
    await malformed([], dual);
  });
  it('D: duplicate/multiple ETH single rows fail closed despite foreign rows', async () => {
    await malformed([position(), ...foreign, position()]);
    await malformed([position(), position(), position(), ...foreign]);
  });
  for (const mode of ['dual_long', 'dual_short']) it(`E: only ETH ${mode} cannot establish both legs`, async () => {
    await malformed([position('ETH_USDT', mode), ...foreign,
      position('SOL_USDT', mode === 'dual_long' ? 'dual_short' : 'dual_long')], true);
  });
  for (const mode of ['dual_long', 'dual_short']) it(`F: duplicate ETH ${mode} fails closed`, async () => {
    await malformed([position('ETH_USDT', mode), ...foreign, position('ETH_USDT', mode)], true);
  });
  it('F: extra ETH dual leg fails closed', async () => {
    await malformed([position('ETH_USDT', 'dual_long'), position('ETH_USDT', 'dual_short'),
      ...foreign, position('ETH_USDT', 'dual_long')], true);
  });
  for (const [label, bad] of [
    ['null', null], ['array', []], ['number', 1], ['string', 'ETH_USDT'],
    ['missing contract', {}], ['null contract', { contract: null }],
    ['numeric contract', { contract: 1 }], ['empty contract', { contract: '' }],
    ['blank contract', { contract: ' \t\n' }],
  ] as const) it(`G: unscopable ${label} row fails even alongside valid ETH`, async () => {
    await malformed([position(), ...foreign, bad]);
  });
  it('H: foreign exposure does not contaminate an ETH factual zero row', async () => {
    const { result } = await readPositions([...foreign, position()]);
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.value?.positions.length, 1);
    assert.equal(result.value?.accountState, 'FLAT'); // ETH scope only, not whole-account flatness.
  });
  it('H: only foreign identity is inspected; foreign schemas never enter ETH normalization', async () => {
    const { result } = await readPositions([{ contract: 'SOL_USDT' }, position()]);
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.value?.positions.length, 1);
  });
  it('I: size zero with nonzero factual value remains OPEN', async () => {
    const { result } = await readPositions([...foreign, position('ETH_USDT', 'single', '0', '2')]);
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.value?.positions[0]?.signedSize, 0);
    assert.equal(result.value?.positions[0]?.quoteValue, 2);
    assert.equal(result.value?.accountState, 'OPEN');
  });
  it('J: opposing ETH legs never become flat by netting', async () => {
    const { result } = await readPositions([position('ETH_USDT', 'dual_long', '1', '2000'), ...foreign,
      position('ETH_USDT', 'dual_short', '-1', '-2000')], true);
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.value?.positions.length, 2);
    assert.equal(result.value?.positions.reduce((sum, p) => sum + p.signedSize, 0), 0);
    assert.equal(result.value?.accountState, 'OPEN');
  });
  it('both factual zero ETH dual legs are the only dual FLAT candidate', async () => {
    const { result } = await readPositions([position('ETH_USDT', 'dual_long'), ...foreign,
      position('ETH_USDT', 'dual_short')], true);
    assert.equal(result.availability, 'AVAILABLE');
    assert.equal(result.value?.positions.length, 2);
    assert.equal(result.value?.accountState, 'FLAT');
  });
  it('non-array top level and unknown account mode fail closed', async () => {
    for (const payload of [null, undefined, {}, '[]', 0]) await malformed(payload);
    await malformed([position(), ...foreign], null);
  });
  it('single/dual mode compatibility is unchanged', async () => {
    await malformed([position('ETH_USDT', 'dual_long'), ...foreign]);
    await malformed([position(), position('ETH_USDT', 'dual_short'), ...foreign], true);
  });
  it('all ETH numeric/mode/price/time requirements remain strict after scoping', async () => {
    for (const patch of [{ size: '' }, { value: undefined }, { value: NaN }, { value: Infinity },
      { mode: 'unknown' }, { entry_price: null }, { mark_price: '' }, { update_time: 'invalid' }]) {
      await malformed([...foreign, { ...position('ETH_USDT', 'single', '1', '2000'), ...patch }]);
    }
  });
});
