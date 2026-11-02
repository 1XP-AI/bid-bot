import test from 'node:test';
import assert from 'node:assert/strict';
import diagnostics from '../validator-bonds-rpc-diagnostics.cjs';

const { withRpcDiagnostics } = diagnostics;

test('RPC diagnostics preserve the structured preflight error and original response', async () => {
  const body = { error: { code: -32002, message: 'Transaction simulation failed', data: { err: 'BlockhashNotFound', logs: [], unitsConsumed: 0 } } };
  const response = new Response(JSON.stringify(body));
  const messages = [];
  const request = { body: JSON.stringify({ method: 'sendTransaction', params: ['signed-transaction'] }) };
  let calls = 0;
  const fetch = withRpcDiagnostics(async (url, init) => {
    calls++;
    assert.equal(init, request);
    return response;
  }, text => messages.push(text));
  const result = await fetch('https://rpc.invalid/secret-api-key', request);
  assert.equal(calls, 1);
  assert.equal(result, response);
  assert.deepEqual(await result.json(), body);
  assert.match(messages.join(''), /BlockhashNotFound/);
  assert.doesNotMatch(messages.join(''), /secret-api-key|signed-transaction/);
});

test('RPC diagnostics leave successful submissions and read requests unchanged', async () => {
  const write = () => assert.fail('nothing to diagnose');
  for (const [method, body] of [
    ['sendTransaction', { result: 'signature' }],
    ['getBalance', { error: { message: 'unrelated error' } }],
  ]) {
    const response = new Response(JSON.stringify(body));
    const fetch = withRpcDiagnostics(async () => response, write);
    assert.equal(await fetch('https://rpc.invalid', { body: JSON.stringify({ method }) }), response);
  }
});

test('diagnostic failures cannot change the RPC result', async () => {
  const response = new Response('non-JSON response');
  const fetch = withRpcDiagnostics(async () => response, () => assert.fail('cannot parse'));
  assert.equal(await fetch('https://rpc.invalid', { body: '{"method":"sendTransaction"}' }), response);
});
