// web3.js can discard error.data.err when turning an RPC preflight failure
// into SendTransactionError. Preserve that diagnostic without changing the
// request, retry behavior, or response consumed by validator-bonds.
function withRpcDiagnostics(fetchImpl, write) {
  return async function rpcDiagnosticsFetch(input, init) {
    const response = await fetchImpl(input, init);
    try {
      const request = JSON.parse(init?.body ?? '{}');
      if (request.method !== 'sendTransaction') return response;
      const body = await response.clone().json();
      if (body.error) {
        const { code, message, data } = body.error;
        write(`[validator-bonds RPC error] ${JSON.stringify({
          code,
          message,
          err: data?.err,
          logs: data?.logs,
          unitsConsumed: data?.unitsConsumed,
        })}\n`);
      }
    } catch {
      // Diagnostics must never interfere with transaction submission.
    }
    return response;
  };
}

if (process.env.BID_BOT_RPC_DIAGNOSTICS === '1' && typeof globalThis.fetch === 'function') {
  globalThis.fetch = withRpcDiagnostics(globalThis.fetch, text => process.stderr.write(text));
}

module.exports = { withRpcDiagnostics };
